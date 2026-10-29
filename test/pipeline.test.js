const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PARAMS, scoringPipeline, statsStages, riskStages, rollingPipeline } = require('../mongo/lib/pipelines');
const { DEFAULTS, computeRisk, statsFromWindow } = require('../reference/scoring');
const { makeRng, makeUsers, normalAmount, spikeAmount } = require('../mongo/lib/synthetic');
const { runPipeline } = require('./mini-agg');

const P = DEFAULT_PARAMS;

test('pipeline parameters equal the reference parameters', () => {
  assert.deepEqual(P, DEFAULTS);
});

test('the pipelines use only built-in aggregation operators (no server-side JavaScript)', () => {
  const walk = (x, found) => {
    if (Array.isArray(x)) x.forEach((v) => walk(v, found));
    else if (x && typeof x === 'object' && !(x instanceof Date))
      for (const [k, v] of Object.entries(x)) { if (k.startsWith('$')) found.add(k); walk(v, found); }
    return found;
  };
  const ops = walk([...scoringPipeline({ txId: 'a', userId: 'u', ts: new Date(), amount: 1, ingestedAt: new Date() }, P),
                    ...rollingPipeline('u', new Date(0), P)], new Set());
  for (const banned of ['$function', '$accumulator', '$where']) assert.ok(!ops.has(banned), banned);
  assert.ok(ops.has('$facet') && ops.has('$stdDevSamp') && ops.has('$setWindowFields') && ops.has('$ln'));
});

// Build a random history for one user, in both forms: MongoDB documents and reference items.
function scenario(rng, now) {
  const user = makeUsers(1, rng)[0];
  const k = rng.int(0, 120);
  const docs = [], items = [];
  for (let i = 0; i < k; i++) {
    const t = now - rng.uniform(0, 900) * 1000;                // some events fall outside the 600 s window
    const flagged = rng.next() < 0.08;
    const amount = rng.next() < 0.05 ? spikeAmount(user, rng) : normalAmount(user, rng);
    docs.push({ ts: new Date(t), meta: { userId: user.id }, amount, flagged });
    items.push({ t, logAmt: Math.log(amount), flagged });
  }
  docs.push({ ts: new Date(now - 1000), meta: { userId: 'someone-else' }, amount: 5, flagged: false }); // must be ignored
  const burstExtra = rng.next() < 0.3 ? rng.int(2, 9) : 0;      // dense recent activity to exercise velocity
  for (let i = 0; i < burstExtra; i++) {
    const t = now - rng.uniform(0, 4) * 1000, amount = normalAmount(user, rng);
    docs.push({ ts: new Date(t), meta: { userId: user.id }, amount, flagged: false });
    items.push({ t, logAmt: Math.log(amount), flagged: false });
  }
  const amount = rng.next() < 0.3 ? spikeAmount(user, rng) : normalAmount(user, rng);
  return { user, docs, items, amount };
}

test('scoring pipeline agrees with the JavaScript reference on 5,000 random histories', () => {
  const rng = makeRng(2026);
  let flaggedCount = 0, warmCount = 0;
  for (let i = 0; i < 5000; i++) {
    const now = 1.8e12;
    const { user, docs, items, amount } = scenario(rng, now);
    const ev = { txId: 't' + i, userId: user.id, ts: new Date(now), amount, ingestedAt: new Date(now - 5), label: null };
    const [got] = runPipeline(scoringPipeline(ev, P), docs, { NOW: new Date(now + 7) });
    const want = computeRisk(amount, statsFromWindow(items, now, P, true), P);

    assert.equal(got.flagged, want.flagged, `flag mismatch in trial ${i}`);
    assert.equal(got.warm, want.warm, `warm mismatch in trial ${i}`);
    assert.equal(got.burst, want.burstCount, `burst mismatch in trial ${i}`);
    assert.ok(Math.abs(got.risk - want.risk) <= 0.051, `risk ${got.risk} vs ${want.risk} in trial ${i}`);
    assert.ok(Math.abs(got.z - want.z) <= 0.0006, `z ${got.z} vs ${want.z} in trial ${i}`);
    assert.deepEqual(got.reasons, want.reasons);
    assert.equal(got.latencyMs, 12);                             // NOW - ingestedAt
    assert.equal(got.label, null);
    flaggedCount += got.flagged; warmCount += got.warm;
  }
  assert.ok(flaggedCount > 200 && flaggedCount < 4000, 'scenarios should include flagged and unflagged events: ' + flaggedCount);
  assert.ok(warmCount > 50, 'scenarios should include warm-up events: ' + warmCount);
});

test('a brand-new user (no history) is scored: warm, velocity from the first event', () => {
  const now = 1.8e12;
  const ev = { txId: 'x', userId: 'new', ts: new Date(now), amount: 50, ingestedAt: new Date(now) };
  const out = runPipeline(scoringPipeline(ev, P), [], { NOW: new Date(now) });
  assert.equal(out.length, 1);
  assert.equal(out[0].warm, true);
  assert.equal(out[0].risk, 0);
  assert.equal(out[0].flagged, false);
  assert.equal(out[0].burst, 1);
  assert.equal(out[0].baselineN, 0);
});

test('flagged events leave the baseline but still count towards velocity', () => {
  const now = 1.8e12;
  const docs = [];
  for (let i = 0; i < 30; i++) docs.push({ ts: new Date(now - 100000 - i * 1000), meta: { userId: 'u' }, amount: 40, flagged: false });
  for (let i = 0; i < 3; i++) docs.push({ ts: new Date(now - 1000 - i * 500), meta: { userId: 'u' }, amount: 4000, flagged: true });
  const ev = { txId: 'x', userId: 'u', ts: new Date(now), amount: 40, ingestedAt: new Date(now) };
  const [r] = runPipeline(scoringPipeline(ev, P), docs, { NOW: new Date(now) });
  assert.equal(r.baselineN, 30);                                 // the three flagged events are excluded
  assert.equal(r.baselineMeanLog, Math.round(Math.log(40) * 1000) / 1000);
  assert.equal(r.burst, 4);                                      // 3 flagged + this event are inside 5 s
});

test('the event under evaluation never contributes to its own baseline', () => {
  const now = 1.8e12;
  const docs = [{ ts: new Date(now + 1000), meta: { userId: 'u' }, amount: 999, flagged: false }]; // a later event
  const ev = { txId: 'x', userId: 'u', ts: new Date(now), amount: 40, ingestedAt: new Date(now) };
  const [r] = runPipeline(scoringPipeline(ev, P), docs, { NOW: new Date(now) });
  assert.equal(r.baselineN, 0);
});

test('stages are split so statistics and scoring can be inspected separately', () => {
  assert.ok(statsStages({ userId: 'u', ts: new Date() }, P).length === 3);
  assert.ok(riskStages(P).length === 5);
});

test('generator helpers are deterministic for a seed', () => {
  const a = makeRng(7), b = makeRng(7);
  assert.deepEqual([a.next(), a.normal(), a.int(1, 9)], [b.next(), b.normal(), b.int(1, 9)]);
});
