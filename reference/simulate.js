'use strict';

/**
 * Offline simulation of the scoring logic (no MongoDB required).
 *
 * It generates labelled synthetic traffic on a simulated clock and replays it through
 * computeRisk() with the baseline computed by statsFromWindow(): the JavaScript reference
 * model of the MongoDB pipeline in mongo/lib/pipelines.js (test/pipeline.test.js checks
 * that the two agree).
 *
 * Outputs results/sim_results.json and prints a summary.
 *
 *   node reference/simulate.js            # default experiment
 *   SEED=7 node reference/simulate.js     # different seed
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_PARAMS } = require('../mongo/lib/pipelines');
const { computeRisk, statsFromWindow } = require('./scoring');
const { makeRng, makeUsers, normalAmount, spikeAmount } = require('../mongo/lib/synthetic');

const EXP = {
  users: 200,
  durationS: 4 * 3600, // simulated seconds of traffic
  warmS: 900,          // no fraud injected before this (baselines need history)
  spikeProb: 0.003,    // fraction of post-warm-up normal events turned into spikes
  burstIncidents: 150,
  burstMin: 10,
  burstMax: 15,
  burstGapMeanS: 0.35,
};

function generate(seed) {
  const rng = makeRng(seed);
  const users = makeUsers(EXP.users, rng);
  const byId = new Map(users.map((u) => [u.id, u]));
  const events = [];

  // Normal traffic: independent Poisson process per user
  for (const u of users) {
    let t = rng.exp(1 / u.rate);
    while (t < EXP.durationS) {
      let label = null;
      let amount;
      if (t > EXP.warmS && rng.next() < EXP.spikeProb) {
        label = 'spike';
        amount = spikeAmount(u, rng);
      } else {
        amount = normalAmount(u, rng);
      }
      events.push({ t: Math.round(t * 1000), u: u.id, amount, label, incident: null });
      t += rng.exp(1 / u.rate);
    }
  }

  // Velocity bursts: 10-15 normal-looking transactions from one user within seconds
  for (let k = 0; k < EXP.burstIncidents; k++) {
    const u = users[rng.int(0, users.length - 1)];
    let t = rng.uniform(EXP.warmS + 60, EXP.durationS - 60);
    const size = rng.int(EXP.burstMin, EXP.burstMax);
    for (let i = 0; i < size; i++) {
      events.push({ t: Math.round(t * 1000), u: u.id, amount: normalAmount(u, rng), label: 'burst', incident: k });
      t += rng.exp(EXP.burstGapMeanS);
    }
  }

  events.sort((a, b) => a.t - b.t);
  return { events, byId };
}

function detect(events, params, excludeFlagged = true) {
  const windows = new Map();
  const out = new Array(events.length);
  const W = params.baselineWindowS * 1000;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    let items = windows.get(ev.u);
    if (!items) windows.set(ev.u, (items = []));
    while (items.length && items[0].t < ev.t - W) items.shift();
    const stats = statsFromWindow(items, ev.t, params, excludeFlagged);
    const r = computeRisk(ev.amount, stats, params);
    items.push({ t: ev.t, logAmt: Math.log(Math.max(ev.amount, 0.01)), flagged: r.flagged });
    out[i] = { risk: r.risk, flagged: r.flagged, reasons: r.reasons, warm: r.warm };
  }
  return out;
}

const ratio = (a, b) => (b === 0 ? null : a / b);
const round = (v, d = 4) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

function evaluate(events, verdicts, byId, params) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let fpNearBurst = 0; // flagged normal events within burstWindowS of a burst event of the SAME user
  const lastBurstT = new Map();
  const spike = { total: 0, hit: 0 };
  const burstEv = { total: 0, hit: 0 };
  const bands = { low: { total: 0, hit: 0 }, mid: { total: 0, hit: 0 }, high: { total: 0, hit: 0 } };
  const fpReason = { AMOUNT_SPIKE: 0, VELOCITY_BURST: 0 };
  const incidents = new Map();
  const normalScores = [];

  events.forEach((ev, i) => {
    const v = verdicts[i];
    const positive = ev.label !== null;
    if (positive && v.flagged) tp++;
    else if (positive) fn++;
    else if (v.flagged) fp++;
    else tn++;

    if (ev.label === 'burst') lastBurstT.set(ev.u, ev.t);
    if (!positive) {
      normalScores.push(v.risk);
      if (v.flagged) {
        for (const r of v.reasons) fpReason[r]++;
        const lb = lastBurstT.get(ev.u);
        if (lb !== undefined && ev.t - lb <= params.burstWindowS * 1000) fpNearBurst++;
      }
    }
    if (ev.label === 'spike') {
      spike.total++;
      if (v.flagged) spike.hit++;
      const s = byId.get(ev.u).sigma;
      const b = s < 0.3 ? 'low' : s < 0.38 ? 'mid' : 'high';
      bands[b].total++;
      if (v.flagged) bands[b].hit++;
    }
    if (ev.label === 'burst') {
      burstEv.total++;
      if (v.flagged) burstEv.hit++;
      let inc = incidents.get(ev.incident);
      if (!inc) incidents.set(ev.incident, (inc = { size: 0, firstT: ev.t, flagIdx: null, flagT: null }));
      inc.size++;
      if (v.flagged && inc.flagIdx === null) {
        inc.flagIdx = inc.size;
        inc.flagT = ev.t;
      }
    }
  });

  const detected = [...incidents.values()].filter((x) => x.flagIdx !== null);
  const delays = detected.map((x) => x.flagIdx).sort((a, b) => a - b);
  const delaySec = detected.map((x) => (x.flagT - x.firstT) / 1000);
  normalScores.sort((a, b) => a - b);
  const pct = (q) => normalScores[Math.min(normalScores.length - 1, Math.floor(q * normalScores.length))];

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    confusion: { tp, fp, fn, tn },
    precision: round(precision),
    recall: round(recall),
    f1: round(precision && recall ? (2 * precision * recall) / (precision + recall) : 0),
    fpr: round(ratio(fp, fp + tn), 6),
    spikeRecall: round(ratio(spike.hit, spike.total)),
    spikeCounts: spike,
    spikeRecallBySigma: Object.fromEntries(
      Object.entries(bands).map(([k, v]) => [k, { ...v, recall: round(ratio(v.hit, v.total)) }])
    ),
    burstEventRecall: round(ratio(burstEv.hit, burstEv.total)),
    burstEventCounts: burstEv,
    burstIncidentRecall: round(ratio(detected.length, incidents.size)),
    burstIncidents: { total: incidents.size, detected: detected.length },
    burstDelayEventsMean: round(delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null, 2),
    burstDelayEventsMedian: delays.length ? delays[Math.floor(delays.length / 2)] : null,
    burstDelaySecondsMean: round(delaySec.length ? delaySec.reduce((a, b) => a + b, 0) / delaySec.length : null, 2),
    normalScorePercentiles: { p50: round(pct(0.5), 2), p99: round(pct(0.99), 2), p999: round(pct(0.999), 2), max: round(normalScores.at(-1), 2) },
    falsePositiveReasons: fpReason,
    falsePositiveAttribution: {
      nearBurst: fpNearBurst,
      organic: fp - fpNearBurst,
      organicFpr: round(ratio(fp - fpNearBurst, fp + tn), 6),
      precisionIfNearBurstCounted: round(ratio(tp + fpNearBurst, tp + fp)),
    },
  };
}

function summarise(m) {
  return {
    precision: m.precision, recall: m.recall, f1: m.f1, fpr: m.fpr,
    spikeRecall: m.spikeRecall, burstEventRecall: m.burstEventRecall, burstIncidentRecall: m.burstIncidentRecall,
    confusion: m.confusion,
  };
}

function main() {
  const seed = Number(process.env.SEED) || 42;
  const params = { ...DEFAULT_PARAMS };
  const { events, byId } = generate(seed);
  const counts = events.reduce((a, e) => ((a[e.label || 'normal']++), a), { normal: 0, spike: 0, burst: 0 });

  // Main run (timed)
  const t0 = process.hrtime.bigint();
  const verdicts = detect(events, params, true);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const main = evaluate(events, verdicts, byId, params);

  // Threshold sweep (each threshold is a full re-run because flagged events feed back into baselines)
  const sweep = [30, 40, 50, 60, 70, 80, 90].map((th) => {
    const m = evaluate(events, detect(events, { ...params, scoreAlert: th }, true), byId, { ...params, scoreAlert: th });
    return { scoreAlert: th, ...summarise(m) };
  });

  // Ablation: let flagged events contaminate the baseline
  const ablation = {
    excludeFlagged: summarise(main),
    includeFlagged: summarise(evaluate(events, detect(events, params, false), byId, params)),
  };

  // Robustness across seeds
  const seeds = [1, 2, 3, 4, 5].map((s) => {
    const g = generate(s);
    const m = evaluate(g.events, detect(g.events, params, true), g.byId, params);
    return { seed: s, events: g.events.length, ...summarise(m) };
  });

  const result = {
    generatedAt: new Date().toISOString(),
    seed,
    experiment: EXP,
    scoringParams: params,
    dataset: { totalEvents: events.length, ...counts },
    main,
    sweep,
    ablation,
    seeds,
    timing: { events: events.length, elapsedMs: round(elapsedMs, 1), eventsPerSecond: Math.round(events.length / (elapsedMs / 1000)) },
  };

  const dir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sim_results.json'), JSON.stringify(result, null, 2));

  console.log(JSON.stringify(result, null, 2));
}

main();
