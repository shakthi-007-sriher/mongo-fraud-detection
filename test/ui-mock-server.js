// Development helper: serves the real dashboard page with an in-memory fake of the API, so the
// page can be tried and tested without MongoDB. Scoring uses the JavaScript reference model.
//   node test/ui-mock-server.js     then open http://localhost:3100
const path = require('path');
const express = require('express');
const { DEFAULT_PARAMS } = require('../mongo/lib/pipelines');
const { computeRisk, statsFromWindow } = require('../reference/scoring');
const { makeRng, makeUsers, normalAmount, spikeAmount } = require('../mongo/lib/synthetic');

const PORT = Number(process.env.PORT) || 3100;
const rng = makeRng(7), users = makeUsers(40, rng);
let cfg = { ...DEFAULT_PARAMS };
const sseClients = new Set(); let sseQueue = [];
const items = new Map(), scores = [], running = { detector: false, generator: false };
const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000;
let seq = 0;

function score(ev) {
  const arr = items.get(ev.userId) || []; items.set(ev.userId, arr);
  const t = ev.ts.getTime(), st = statsFromWindow(arr, t, cfg, true), v = computeRisk(ev.amount, st, cfg);
  arr.push({ t, logAmt: Math.log(Math.max(ev.amount, 0.01)), flagged: v.flagged });
  scores.push({ txId: ev.txId, userId: ev.userId, ts: ev.ts, amount: ev.amount, risk: r1(v.risk), flagged: v.flagged, z: r3(v.z), burst: v.burstCount,
    baselineN: st.n, baselineMeanLog: st.meanLog == null ? null : r3(st.meanLog), baselineSdLog: st.sdLog == null ? null : r3(st.sdLog),
    baselineVarLog: st.varLog == null ? null : r3(st.varLog), reasons: v.reasons, warm: v.warm, label: ev.label || null, incidentId: ev.incidentId || null,
    ingestedAt: ev.ingestedAt, deviceId: ev.deviceId || null, country: ev.country || null, homeCountry: ev.homeCountry || null, latencyMs: 9 + Math.floor(Math.random() * 14) });
  if (scores.length > 20000) scores.shift();
  if (sseClients.size) sseQueue.push(scores[scores.length - 1]);
}
const mk = (u, ts, label, amount, inc, o = {}) => ({ txId: 'm' + (seq++), userId: u.id, amount, ts, ingestedAt: ts, label, incidentId: inc || null, deviceId: o.deviceId || u.deviceId, country: o.country || u.homeCountry, homeCountry: u.homeCountry });
// history: 60 normal events per user over the last 9 minutes
for (const u of users) for (let i = 0; i < 60; i++) { const ts = new Date(Date.now() - (540 - i * 9) * 1000); score(mk(u, ts, null, normalAmount(u, rng))); }
const started = Date.now();
setInterval(() => {
  if (!running.generator || !running.detector) return;
  const fraud = Date.now() - started > 15000;
  for (let i = 0; i < 3; i++) {
    const u = users[rng.int(0, users.length - 1)], now = new Date();
    if (fraud && rng.next() < 0.03) score(mk(u, now, 'spike', spikeAmount(u, rng)));
    else score(mk(u, now, null, normalAmount(u, rng)));
  }
  if (fraud && rng.next() < 0.04) { const u = users[rng.int(0, users.length - 1)]; for (let k = 0; k < 12; k++) setTimeout(() => score(mk(u, new Date(), 'burst', normalAmount(u, rng), 'inc' + seq)), k * 300); }
}, 400);

const app = express(); app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'dashboard', 'public')));
const strip = (d) => d;
const since = (min) => Date.now() - min * 60000;
const err = (res, code, m) => res.status(code).json({ error: m });
app.get('/api/feed', (q, r) => r.json(scores.slice(-40).reverse().map(({ txId, userId, amount, ts, risk, flagged, reasons }) => ({ txId, userId, amount, ts, risk, flagged, reasons }))));
app.get('/api/alerts', (q, r) => r.json(scores.filter((s) => s.flagged).slice(-15).reverse()));
app.get('/api/stats', (q, r) => {
  const w = scores.filter((s) => s.ts.getTime() >= since(1)), per = new Map();
  for (const s of w) { const k = Math.floor(s.ts.getTime() / 1000) * 1000; const o = per.get(k) || { t: new Date(k), total: 0, flagged: 0 }; o.total++; o.flagged += s.flagged ? 1 : 0; per.set(k, o); }
  r.json({ perSecond: [...per.values()].sort((a, b) => a.t - b.t), last60s: { events: w.length, flagged: w.filter((s) => s.flagged).length, eventsPerSecond: Math.round(w.length / 6) / 10, avgLatencyMs: 14, maxLatencyMs: 30 } });
});
app.get('/api/event/:id', (q, r) => { const e = scores.find((s) => s.txId === q.params.id); if (!e) return err(r, 404, 'not scored yet');
  const du = [...new Set(scores.filter((s) => s.deviceId === e.deviceId).map((s) => s.userId))].slice(0, 12);
  const seen = scores.some((s) => s.userId === e.userId && s.deviceId === e.deviceId && s.ts < e.ts);
  r.json({ ...e, geoMismatch: !!(e.country && e.homeCountry && e.country !== e.homeCountry), newDevice: !seen, deviceUsers: du }); });
app.get('/api/stream', (q, r) => { r.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); r.flushHeaders(); sseClients.add(r); q.on('close', () => sseClients.delete(r)); });
setInterval(() => { if (sseQueue.length) { const m = 'data: ' + JSON.stringify(sseQueue) + '\n\n'; for (const c of sseClients) c.write(m); } sseQueue = []; }, 250);
app.get('/api/readiness', (q, r) => r.json({ users: users.length, ready: warm(99).length }));
const warm = (n) => users.filter((u) => (items.get(u.id) || []).length >= 25).slice(0, n);
const foreign = (h) => (h === 'US' ? 'GB' : 'US');
app.post('/api/attack', (q, r) => {
  const sc = q.body.scenario, id = 'atk' + Date.now(), ids = [], send = (u, amount, label, o, delay) => { const doc = mk(u, new Date(), label, amount, label ? id : null, o); ids.push(doc.txId); setTimeout(() => { doc.ts = new Date(); doc.ingestedAt = doc.ts; if (running.detector) score(doc); }, delay); };
  const n = sc === 'botnet' ? Math.min(12, Math.max(3, Number(q.body.size) || 6)) : 1, us = warm(n);
  if (us.length < n) return err(r, 409, 'Not enough users with history yet.');
  let what;
  if (sc === 'botnet') { const dev = 'bot-x1'; us.forEach((u, i) => send(u, u.median * 10, 'spike', { deviceId: dev, country: foreign(u.homeCountry) }, i * 400)); what = n + ' accounts used one device.'; }
  else if (sc === 'cardtest') { const u = us[0]; for (let i = 0; i < 12; i++) send(u, 1 + Math.random() * 2, 'burst', { deviceId: 'new-c1', country: foreign(u.homeCountry) }, i * 250); what = u.id + ' made 12 tiny payments.'; }
  else if (sc === 'travel') { const u = us[0]; send(u, u.median, null, {}, 0); send(u, u.median * 8, 'spike', { deviceId: 'new-t1', country: foreign(u.homeCountry) }, 2500); what = u.id + ' travelled.'; }
  else return err(r, 400, 'unknown scenario');
  r.json({ scenario: sc, what, users: us.map((u) => u.id), txIds: ids });
});
app.get('/api/rings', (q, r) => {
  const w = scores.filter((s) => s.flagged && s.deviceId && s.ts.getTime() >= since(Number(q.query.minutes) || 30)), byDev = new Map();
  for (const s of w) { const a = byDev.get(s.deviceId) || new Map(); a.set(s.userId, (a.get(s.userId) || 0) + 1); byDev.set(s.deviceId, a); }
  const rings = [];
  for (const [dev, m] of byDev) if (m.size > 1) rings.push({ ringId: [...m.keys()].sort()[0], size: m.size, totalAlerts: [...m.values()].reduce((x, y) => x + y, 0),
    members: [...m].map(([userId, alerts]) => ({ userId, alerts, maxRisk: 100, devices: [dev] })) });
  r.json(rings);
});
const savedRules = [];
app.post('/api/rules/test', (q, r) => {
  const rule = q.body.rule || {}, w = scores.filter((s) => s.ts.getTime() >= since(Number(q.body.minutes) || 30));
  const hit = (s) => (rule.conditions || []).every((c) => (c.op === 'gte' ? s[c.field] >= c.value : s[c.field] <= c.value)) && (!rule.geoMismatch || (s.country && s.homeCountry && s.country !== s.homeCountry)) && (!rule.newDevice || /^(new|bot)-/.test(s.deviceId || ''));
  if (!(rule.conditions || []).length && !rule.geoMismatch && !rule.newDevice) return err(r, 400, 'add at least one condition');
  const conf = (f) => { const o = { tp: 0, fp: 0, fn: 0, tn: 0 }; for (const s of w) o[f(s) ? (s.label ? 'tp' : 'fp') : (s.label ? 'fn' : 'tn')]++; return o; };
  r.json({ rule: conf(hit), model: conf((s) => s.flagged), samples: w.filter(hit).slice(-10).reverse() });
});
app.get('/api/rules', (q, r) => r.json(savedRules));
app.post('/api/rules', (q, r) => { if (!q.body.name) return err(r, 400, 'give the rule a name'); savedRules.unshift({ _id: 'r' + savedRules.length, name: q.body.name, rule: q.body.rule, savedAt: new Date() }); r.json({ ok: true }); });
app.delete('/api/rules/:id', (q, r) => { const i = savedRules.findIndex((x) => x._id === q.params.id); if (i >= 0) savedRules.splice(i, 1); r.json({ ok: true }); });
app.get('/api/user/:id', (q, r) => {
  const id = q.params.id, a = scores.filter((s) => s.userId === id), clean = a.filter((s) => !s.flagged);
  let profile = null;
  if (a.length) { const logs = clean.map((s) => Math.log(s.amount)), m = logs.reduce((x, y) => x + y, 0) / logs.length;
    const sd = logs.length > 1 ? Math.sqrt(logs.reduce((x, y) => x + (y - m) ** 2, 0) / (logs.length - 1)) : null;
    profile = { events: a.length, flagged: a.filter((s) => s.flagged).length, last: a[a.length - 1].ts, typical: Math.round(Math.exp(m) * 100) / 100, sdLog: sd == null ? null : r3(sd) }; }
  r.json({ userId: id, profile, recent: a.slice(-30).reverse() });
});
app.get('/api/users/top', (q, r) => {
  const w = scores.filter((s) => s.ts.getTime() >= since(Number(q.query.minutes) || 10)), f = new Map(), b = new Map();
  for (const s of w) { b.set(s.userId, (b.get(s.userId) || 0) + 1); if (s.flagged) { const o = f.get(s.userId) || { alerts: 0, maxRisk: 0 }; o.alerts++; o.maxRisk = Math.max(o.maxRisk, s.risk); f.set(s.userId, o); } }
  r.json({ flagged: [...f].map(([userId, o]) => ({ userId, ...o })).sort((x, y) => y.alerts - x.alerts).slice(0, 8), busy: [...b].map(([userId, events]) => ({ userId, events })).sort((x, y) => y.events - x.events).slice(0, 12) });
});
app.get('/api/rolling/:id', (q, r) => {
  const a = scores.filter((s) => s.userId === q.params.id && s.ts.getTime() >= since(30)).sort((x, y) => x.ts - y.ts), out = [];
  a.forEach((s, i) => { const w = a.filter((x, j) => j <= i && s.ts - x.ts <= 600000).map((x) => x.amount), m = w.reduce((x, y) => x + y, 0) / w.length;
    const sd = w.length > 1 ? Math.sqrt(w.reduce((x, y) => x + (y - m) ** 2, 0) / (w.length - 1)) : null;
    out.push({ txId: s.txId, ts: s.ts, amount: s.amount, risk: s.risk, flagged: s.flagged, rollingAvg: m, rollingStd: sd, rollingVar: sd == null ? null : sd * sd }); });
  r.json(out.slice(-300));
});
app.post('/api/transactions', (q, r) => {
  const b = q.body || {}; if (!/^[\w.-]{1,40}$/.test(b.userId || '')) return err(r, 400, 'invalid user id');
  const amount = Number(b.amount); if (!(amount > 0)) return err(r, 400, 'amount must be above 0');
  const kind = b.kind, count = kind === 'burst' ? 12 : 1, label = kind === 'spike' || kind === 'burst' ? kind : null, inc = kind === 'burst' ? 'ui' + seq : null, ids = [];
  for (let i = 0; i < count; i++) { const id = 'ui' + (seq++); ids.push(id); const u = { id: b.userId };
    setTimeout(() => { if (running.detector) score({ txId: id, userId: b.userId, amount: Math.round(amount * (i ? 0.9 + Math.random() * 0.2 : 1) * 100) / 100, ts: new Date(), ingestedAt: new Date(), label, incidentId: inc }); }, i * (Number(b.gapMs) || 250) + 150); }
  r.json({ txIds: ids });
});
app.get('/api/config', (q, r) => r.json(cfg));
app.post('/api/config', (q, r) => { const n = { ...cfg, ...Object.fromEntries(Object.entries(q.body || {}).map(([k, v]) => [k, Number(v)])) };
  if (n.zLow >= n.zHigh) return err(r, 400, 'zLow must be below zHigh'); if (n.burstSoft >= n.burstHard) return err(r, 400, 'burstSoft must be below burstHard'); cfg = n; r.json(cfg); });
app.post('/api/config/reset', (q, r) => { cfg = { ...DEFAULT_PARAMS }; r.json(cfg); });
app.get('/api/risk-buckets', (q, r) => {
  const w = scores.filter((s) => s.ts.getTime() >= since(Number(q.query.minutes) || 10)), m = new Map();
  for (const s of w) { const lo = Math.min(100, Math.floor(s.risk / 5) * 5), o = m.get(lo) || { lower: lo, pos: 0, neg: 0 }; if (s.label) o.pos++; else o.neg++; m.set(lo, o); }
  r.json([...m.values()].sort((a, b) => a.lower - b.lower));
});
app.get('/api/pipeline', (q, r) => r.json({ detector: { running: running.detector, log: running.detector ? ['change stream started'] : [] }, generator: { running: running.generator, log: running.generator ? ['generator: mock users'] : [] } }));
app.post('/api/pipeline/:n/:a', (q, r) => { running[q.params.n] = q.params.a === 'start'; r.json({ ok: true }); });
app.listen(PORT, () => console.log('UI mock on http://localhost:' + PORT));
