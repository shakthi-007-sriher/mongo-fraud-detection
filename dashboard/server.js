// Web layer for the dashboard. It serves the page and exposes a small JSON API. Every statistic
// is computed inside MongoDB (views and aggregation pipelines); this file only passes results on.
// It can also start and stop the detector and generator (mongosh scripts) for you.
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { DEFAULT_PARAMS, rollingPipeline } = require('../mongo/lib/pipelines');

const ROOT = path.join(__dirname, '..');
const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/?directConnection=true';
const dbName = process.env.DB_NAME || 'fraudlab';
const PORT = Number(process.env.PORT) || 3000;

// Allowed settings and their ranges (checked before anything is written to the database).
const LIMITS = { scoreAlert: [10, 100], zLow: [0.5, 6], zHigh: [2, 12], burstSoft: [1, 20], burstHard: [2, 40],
                 sdFloor: [0.01, 1], minHistory: [1, 200], baselineWindowS: [60, 3600], burstWindowS: [1, 60] };
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const userIdOf = (v) => { if (!/^[\w.-]{1,40}$/.test(String(v || ''))) throw bad('invalid user id'); return String(v); };
const minutesOf = (v) => Math.min(120, Math.max(1, Number(v) || 10));

// ---- child processes: the detector and generator are mongosh scripts ----
const procs = {};   // name -> { child, log: [], startedAt }
const SCRIPTS = { detector: 'mongo/02_detector.js', generator: 'mongo/03_generator.js' };
function logTo(p, chunk) { for (const l of String(chunk).split(/\r?\n/)) if (l.trim()) { p.log.push(l); if (p.log.length > 200) p.log.shift(); } }
function statusOf(name) {
  const p = procs[name];
  return { running: !!(p && p.alive), log: p ? p.log.slice(-40) : [] };
}
function startProc(name, env) {
  if (statusOf(name).running) throw Object.assign(new Error(name + ' is already running'), { status: 409 });
  const p = { log: [], alive: true, startedAt: Date.now() };
  p.child = spawn('mongosh', [uri, '--quiet', '--file', SCRIPTS[name]], { cwd: ROOT, env: { ...process.env, DB_NAME: dbName, ...env } });
  p.child.stdout.on('data', (c) => logTo(p, c));
  p.child.stderr.on('data', (c) => logTo(p, c));
  p.child.on('error', (e) => { p.alive = false; logTo(p, e.code === 'ENOENT' ? 'mongosh was not found. Install it (winget install MongoDB.Shell) and restart this server.' : String(e)); });
  p.child.on('exit', (code) => { p.alive = false; logTo(p, 'stopped (exit code ' + code + ')'); });
  procs[name] = p;
}
function stopProc(name) {
  const p = procs[name];
  if (!p || !p.alive) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.child.pid), '/T', '/F']);
  else p.child.kill('SIGTERM');
}
const stopAll = () => Object.keys(procs).forEach(stopProc);
process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });

(async () => {
  const db = (await new MongoClient(uri).connect()).db(dbName);
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  const rows = (name) => db.collection(name).find({}, { projection: { _id: 0 } }).toArray();
  const route = (method, url, fn) => app[method](url, (req, res, next) => Promise.resolve(fn(req)).then((r) => res.json(r), next));
  const config = async () => ({ ...DEFAULT_PARAMS, ...(await db.collection('config').findOne({ _id: 'scoring' }, { projection: { _id: 0 } })) });

  // ---- live monitor (the views created by mongo/01_setup.js) ----
  route('get', '/api/feed', () => rows('v_feed'));
  route('get', '/api/alerts', () => rows('v_alerts'));
  route('get', '/api/stats', async () => {
    const [perSecond, totals] = await Promise.all([rows('v_per_second'), rows('v_last_minute')]);
    return { perSecond, last60s: totals[0] || { events: 0, flagged: 0, eventsPerSecond: 0, avgLatencyMs: null } };
  });

  // ---- investigation ----
  route('get', '/api/event/:txId', async (req) => {
    const e = await db.collection('tx_scores').findOne({ txId: String(req.params.txId) }, { projection: { _id: 0 } });
    if (!e) throw Object.assign(new Error('not scored yet'), { status: 404 });
    // Extra context for the explanation panel: geography and device history.
    const sc = db.collection('tx_scores');
    const sinceDev = new Date(e.ts.getTime() - 30 * 60000);
    const [deviceUsers, seenBefore] = e.deviceId ? await Promise.all([
      sc.aggregate([{ $match: { deviceId: e.deviceId, ts: { $gte: sinceDev } } }, { $group: { _id: '$userId' } }, { $limit: 12 }]).toArray(),
      sc.findOne({ userId: e.userId, deviceId: e.deviceId, ts: { $lt: e.ts } }, { projection: { _id: 1 } }),
    ]) : [[], null];
    return { ...e, geoMismatch: !!(e.country && e.homeCountry && e.country !== e.homeCountry),
             newDevice: !!e.deviceId && !seenBefore, deviceUsers: deviceUsers.map((x) => x._id) };
  });
  route('get', '/api/user/:userId', async (req) => {
    const id = userIdOf(req.params.userId);
    const clean = { $cond: ['$flagged', null, { $ln: '$amount' }] };
    const [profile] = await db.collection('tx_history').aggregate([
      { $match: { 'meta.userId': id } },
      { $group: { _id: null, events: { $sum: 1 }, flagged: { $sum: { $cond: ['$flagged', 1, 0] } },
                  meanLog: { $avg: clean }, sdLog: { $stdDevSamp: clean }, last: { $max: '$ts' } } },
      { $project: { _id: 0, events: 1, flagged: 1, last: 1, typical: { $round: [{ $exp: '$meanLog' }, 2] }, sdLog: { $round: ['$sdLog', 3] } } },
    ]).toArray();
    const recent = await db.collection('tx_scores').find({ userId: id }, { projection: { _id: 0 } }).sort({ ts: -1 }).limit(30).toArray();
    return { userId: id, profile: profile || null, recent };
  });
  route('get', '/api/users/top', async (req) => {
    const since = new Date(Date.now() - minutesOf(req.query.minutes) * 60000);
    const [r] = await db.collection('tx_scores').aggregate([
      { $match: { ts: { $gte: since } } },
      { $facet: {
          flagged: [{ $match: { flagged: true } }, { $group: { _id: '$userId', alerts: { $sum: 1 }, maxRisk: { $max: '$risk' } } },
                    { $sort: { alerts: -1 } }, { $limit: 8 }, { $project: { _id: 0, userId: '$_id', alerts: 1, maxRisk: 1 } }],
          busy: [{ $group: { _id: '$userId', events: { $sum: 1 } } }, { $sort: { events: -1 } }, { $limit: 12 },
                 { $project: { _id: 0, userId: '$_id', events: 1 } }] } },
    ]).toArray();
    return r;
  });
  route('get', '/api/rolling/:userId', (req) =>
    db.collection('tx_history').aggregate(rollingPipeline(userIdOf(req.params.userId), new Date(Date.now() - 30 * 60000), DEFAULT_PARAMS)).toArray());

  // ---- try it yourself: insert a transaction into the inbox; the detector scores it ----
  route('post', '/api/transactions', async (req) => {
    const b = req.body || {};
    const userId = userIdOf(b.userId);
    const amount = Number(b.amount);
    if (!(amount > 0 && amount <= 1e7)) throw bad('amount must be above 0');
    const kind = ['normal', 'spike', 'burst', 'custom'].includes(b.kind) ? b.kind : 'custom';
    const count = kind === 'burst' ? Math.min(30, Math.max(2, Number(b.count) || 12)) : 1;
    const gapMs = Math.min(2000, Math.max(50, Number(b.gapMs) || 250));
    const label = kind === 'spike' || kind === 'burst' ? kind : null;
    const incidentId = kind === 'burst' ? 'ui-' + Date.now() : null;
    const make = (i) => ({ txId: new ObjectId().toString(), userId, amount: Math.round(amount * (i ? 0.9 + Math.random() * 0.2 : 1) * 100) / 100,
                           ts: new Date(), ingestedAt: new Date(), label, incidentId, source: 'ui' });
    const first = make(0);
    try { await db.collection('tx_inbox').insertOne(first); }
    catch (e) { throw bad('MongoDB rejected the transaction: ' + e.message); }
    const txIds = [first.txId];
    for (let i = 1; i < count; i++) {
      const doc = make(i); txIds.push(doc.txId);
      setTimeout(() => { doc.ts = new Date(); doc.ingestedAt = new Date(); db.collection('tx_inbox').insertOne(doc).catch(console.error); }, i * gapMs);
    }
    return { txIds };
  });

  // ---- tuning and what-if ----
  route('get', '/api/config', config);
  route('post', '/api/config', async (req) => {
    const next = { ...(await config()) };
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!LIMITS[k]) throw bad('unknown setting ' + k);
      const n = Number(v);
      if (!(n >= LIMITS[k][0] && n <= LIMITS[k][1])) throw bad(k + ' must be between ' + LIMITS[k].join(' and '));
      next[k] = n;
    }
    if (next.zLow >= next.zHigh) throw bad('zLow must be below zHigh');
    if (next.burstSoft >= next.burstHard) throw bad('burstSoft must be below burstHard');
    await db.collection('config').replaceOne({ _id: 'scoring' }, { _id: 'scoring', ...next }, { upsert: true });
    return next;
  });
  route('post', '/api/config/reset', async () => {
    await db.collection('config').replaceOne({ _id: 'scoring' }, { _id: 'scoring', ...DEFAULT_PARAMS }, { upsert: true });
    return { ...DEFAULT_PARAMS };
  });
  // Risk scores in buckets of 5, split into labelled fraud (pos) and normal (neg) events.
  route('get', '/api/risk-buckets', async (req) => {
    const since = new Date(Date.now() - minutesOf(req.query.minutes) * 60000);
    const isPos = { $eq: [{ $type: '$label' }, 'string'] };
    const boundaries = Array.from({ length: 21 }, (_, i) => i * 5).concat([101]);
    const out = await db.collection('tx_scores').aggregate([
      { $match: { ts: { $gte: since } } },
      { $bucket: { groupBy: '$risk', boundaries, default: 'other',
                   output: { pos: { $sum: { $cond: [isPos, 1, 0] } }, neg: { $sum: { $cond: [isPos, 0, 1] } } } } },
      { $project: { _id: 0, lower: '$_id', pos: 1, neg: 1 } },
    ]).toArray();
    return out.filter((b) => typeof b.lower === 'number');
  });

  // ---- live push: a change stream on tx_scores, relayed to browsers as Server-Sent Events ----
  const clients = new Set();
  let queue = [];
  app.get('/api/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  setInterval(() => {                       // send events in small batches, 4 times a second
    if (queue.length && clients.size) { const msg = 'data: ' + JSON.stringify(queue) + '\n\n'; for (const c of clients) c.write(msg); }
    queue = [];
  }, 250);
  setInterval(() => { for (const c of clients) c.write(': keep-alive\n\n'); }, 20000);
  function startStream() {
    const cs = db.collection('tx_scores').watch([{ $match: { operationType: 'insert' } }]);
    let restarted = false;
    const again = (why) => { if (restarted) return; restarted = true; console.error('score stream ended (' + why + '); retrying'); cs.close().catch(() => {}); setTimeout(startStream, 3000); };
    cs.on('change', (ch) => {
      const d = ch.fullDocument;
      if (clients.size) queue.push({ txId: d.txId, userId: d.userId, amount: d.amount, ts: d.ts, risk: d.risk, flagged: d.flagged, z: d.z, burst: d.burst,
                                     reasons: d.reasons, label: d.label, country: d.country, homeCountry: d.homeCountry, deviceId: d.deviceId });
      if (queue.length > 2000) queue = queue.slice(-1000);
    });
    cs.on('error', (e) => again(e.message));
    cs.on('close', () => again('closed'));
  }
  startStream();

  // ---- attack lab: inject a staged attack into the inbox; the detector scores it like any other event ----
  const COUNTRIES = ['IN', 'US', 'GB', 'DE', 'SG', 'AU', 'CA', 'FR'];
  const foreignTo = (home) => { const o = COUNTRIES.filter((c) => c !== home); return o[Math.floor(Math.random() * o.length)]; };
  const round2 = (v) => Math.max(0.01, Math.round(v * 100) / 100);
  // Users with enough recent clean history to have a baseline, with their typical amount (geometric mean).
  const warmUsers = (n) => db.collection('tx_scores').aggregate([
    { $match: { ts: { $gte: new Date(Date.now() - 10 * 60000) }, flagged: false } },
    { $group: { _id: '$userId', n: { $sum: 1 }, meanLog: { $avg: { $ln: '$amount' } }, home: { $first: '$homeCountry' }, device: { $first: '$deviceId' } } },
    { $match: { n: { $gte: 22 } } }, { $sample: { size: n } },
    { $project: { _id: 0, userId: '$_id', typical: { $exp: '$meanLog' }, home: 1, device: 1 } },
  ]).toArray();
  function sendLater(docs) {                // docs carry a delay in ms; ts is stamped at send time
    for (const { delay, doc } of docs) setTimeout(() => { doc.ts = new Date(); doc.ingestedAt = new Date(); db.collection('tx_inbox').insertOne(doc).catch(console.error); }, delay);
  }
  const mkDoc = (o) => ({ txId: new ObjectId().toString(), userId: o.userId, amount: round2(o.amount), ts: new Date(), ingestedAt: new Date(),
                          label: o.label, incidentId: o.incidentId, deviceId: o.deviceId, country: o.country, homeCountry: o.home || null, source: 'attack' });
  route('post', '/api/attack', async (req) => {
    const scenario = String((req.body || {}).scenario);
    const incidentId = 'atk-' + Date.now();
    const need = scenario === 'botnet' ? Math.min(12, Math.max(3, Number((req.body || {}).size) || 6)) : 1;
    const users = await warmUsers(need);
    if (users.length < need) throw Object.assign(new Error('Not enough users with history yet. Start the detector and generator and wait about 2 minutes, then try again.'), { status: 409 });
    const plan = [];
    let what;
    if (scenario === 'botnet') {
      const device = 'bot-' + Math.random().toString(36).slice(2, 8), country = foreignTo(users[0].home);
      users.forEach((u, i) => plan.push({ delay: i * 400, doc: mkDoc({ userId: u.userId, amount: u.typical * 10, label: 'spike', incidentId, deviceId: device, country, home: u.home }) }));
      what = users.length + ' accounts used the same device (' + device + ') for amounts about 10 times their norm.';
    } else if (scenario === 'cardtest') {
      const u = users[0], device = 'new-' + Math.random().toString(36).slice(2, 8), country = foreignTo(u.home);
      for (let i = 0; i < 12; i++) plan.push({ delay: i * 250, doc: mkDoc({ userId: u.userId, amount: 1 + Math.random() * 2, label: 'burst', incidentId, deviceId: device, country, home: u.home }) });
      what = u.userId + ' made 12 tiny payments in 3 seconds from a new device.';
    } else if (scenario === 'travel') {
      const u = users[0], country = foreignTo(u.home);
      plan.push({ delay: 0, doc: mkDoc({ userId: u.userId, amount: u.typical, label: null, incidentId: null, deviceId: u.device, country: u.home, home: u.home }) });
      plan.push({ delay: 2500, doc: mkDoc({ userId: u.userId, amount: u.typical * 8, label: 'spike', incidentId, deviceId: 'new-' + Math.random().toString(36).slice(2, 8), country, home: u.home }) });
      what = u.userId + ' paid at home in ' + u.home + ', then 2.5 seconds later made a large payment from ' + country + ' on a new device.';
    } else throw bad('unknown scenario');
    sendLater(plan);
    return { scenario, what, users: users.map((u) => u.userId), txIds: plan.map((x) => x.doc.txId) };
  });

  // How many customers already have enough history to be attacked / judged (used by the readiness meter).
  route('get', '/api/readiness', async () => {
    const [r] = await db.collection('tx_scores').aggregate([
      { $match: { ts: { $gte: new Date(Date.now() - 10 * 60000) }, flagged: false } },
      { $group: { _id: '$userId', n: { $sum: 1 } } },
      { $group: { _id: null, users: { $sum: 1 }, ready: { $sum: { $cond: [{ $gte: ['$n', 22] }, 1, 0] } } } },
    ]).toArray();
    return { users: r ? r.users : 0, ready: r ? r.ready : 0 };
  });

  // ---- fraud rings: accounts linked through shared devices, found with $graphLookup ----
  route('get', '/api/rings', async (req) => {
    const since = new Date(Date.now() - minutesOf(req.query.minutes || 30) * 60000);
    // 1. One document per flagged account, listing the devices it used. $out replaces the collection in one step.
    await db.collection('tx_scores').aggregate([
      { $match: { ts: { $gte: since }, flagged: true, deviceId: { $ne: null } } },
      { $group: { _id: '$userId', devices: { $addToSet: '$deviceId' }, alerts: { $sum: 1 }, maxRisk: { $max: '$risk' } } },
      { $out: 'ring_accounts' },
    ]).toArray();
    // 2. Follow device links from every account: accounts that share a device (directly or through others) form a ring.
    return db.collection('ring_accounts').aggregate([
      { $graphLookup: { from: 'ring_accounts', startWith: '$devices', connectFromField: 'devices', connectToField: 'devices', as: 'ring', maxDepth: 5 } },
      { $set: { ringId: { $min: '$ring._id' }, size: { $size: '$ring' } } },
      { $match: { size: { $gte: 2 } } },
      { $group: { _id: '$ringId', size: { $first: '$size' }, members: { $push: { userId: '$_id', alerts: '$alerts', maxRisk: '$maxRisk', devices: '$devices' } } } },
      { $sort: { size: -1 } }, { $limit: 20 },
      { $project: { _id: 0, ringId: '$_id', size: 1, members: 1, totalAlerts: { $sum: '$members.alerts' } } },
    ]).toArray();
  });

  // ---- rule sandbox: back-test a custom rule against recent scored events, entirely in an aggregation ----
  const RULE_FIELDS = ['amount', 'risk', 'z', 'burst'];
  function ruleExpr(rule) {
    const conds = [];
    for (const c of Array.isArray(rule.conditions) ? rule.conditions : []) {
      if (!RULE_FIELDS.includes(c.field) || !['gte', 'lte'].includes(c.op) || !Number.isFinite(Number(c.value))) throw bad('invalid condition');
      conds.push({ ['$' + c.op]: ['$' + c.field, Number(c.value)] });
    }
    if (rule.geoMismatch) conds.push({ $and: [{ $ne: [{ $type: '$country' }, 'null'] }, { $ne: [{ $type: '$homeCountry' }, 'null'] }, { $ne: ['$country', '$homeCountry'] }] });
    if (rule.newDevice) conds.push({ $regexMatch: { input: { $ifNull: ['$deviceId', ''] }, regex: '^(new|bot)-' } });
    if (!conds.length) throw bad('add at least one condition');
    if (conds.length > 8) throw bad('too many conditions');
    return { $and: conds };
  }
  route('post', '/api/rules/test', async (req) => {
    const b = req.body || {};
    const since = new Date(Date.now() - minutesOf(b.minutes) * 60000);
    const isPos = { $eq: [{ $type: '$label' }, 'string'] };
    const [r] = await db.collection('tx_scores').aggregate([
      { $match: { ts: { $gte: since } } },
      { $set: { hit: ruleExpr(b.rule || {}), pos: isPos } },
      { $facet: {
          rule: [{ $group: { _id: { hit: '$hit', pos: '$pos' }, n: { $sum: 1 } } }],
          model: [{ $group: { _id: { hit: '$flagged', pos: '$pos' }, n: { $sum: 1 } } }],
          samples: [{ $match: { hit: true } }, { $sort: { ts: -1 } }, { $limit: 10 },
                    { $project: { _id: 0, txId: 1, userId: 1, amount: 1, risk: 1, z: 1, burst: 1, country: 1, homeCountry: 1, ts: 1, label: 1, flagged: 1 } }] } },
    ]).toArray();
    const conf = (rows) => { const o = { tp: 0, fp: 0, fn: 0, tn: 0 }; for (const x of rows) o[x._id.hit ? (x._id.pos ? 'tp' : 'fp') : (x._id.pos ? 'fn' : 'tn')] += x.n; return o; };
    return { rule: conf(r.rule), model: conf(r.model), samples: r.samples };
  });
  route('get', '/api/rules', () => db.collection('rules').find({}).sort({ savedAt: -1 }).limit(50).toArray());
  route('post', '/api/rules', async (req) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) throw bad('give the rule a name');
    ruleExpr(b.rule || {});                 // validate
    const rule = { conditions: b.rule.conditions || [], geoMismatch: !!b.rule.geoMismatch, newDevice: !!b.rule.newDevice };
    await db.collection('rules').replaceOne({ name }, { name, rule, savedAt: new Date() }, { upsert: true });
    return { ok: true };
  });
  route('delete', '/api/rules/:id', async (req) => {
    await db.collection('rules').deleteOne({ _id: new ObjectId(String(req.params.id)) });
    return { ok: true };
  });

  // ---- pipeline control ----
  route('get', '/api/pipeline', () => ({ detector: statusOf('detector'), generator: statusOf('generator') }));
  route('post', '/api/pipeline/:name/:action', (req) => {
    const { name, action } = req.params;
    if (!SCRIPTS[name] || !['start', 'stop'].includes(action)) throw bad('unknown pipeline action');
    if (action === 'stop') stopProc(name);
    else {
      const env = {};
      if (name === 'generator') {
        const b = req.body || {};
        env.USERS = String(Math.min(2000, Math.max(10, Number(b.users) || 200)));
        env.WARM_S = String(Math.min(900, Math.max(0, b.warmS === undefined ? 60 : Number(b.warmS))));
      }
      startProc(name, env);
    }
    return { ok: true };
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use((err, req, res, next) => {
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  });
  app.listen(PORT, () => console.log('dashboard on http://localhost:' + PORT));
})();
