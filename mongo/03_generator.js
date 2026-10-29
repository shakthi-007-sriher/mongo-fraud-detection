// Live synthetic transaction generator: inserts labelled events into tx_inbox in real time.
//   mongosh --file mongo/03_generator.js
//
// Environment variables (all optional), set in PowerShell as  $env:USERS=500; mongosh ...
//   USERS        simulated users (default 500, about 75 events/s)
//   SEED         random seed (default: random)
//   DURATION_S   stop after this many seconds, 0 = run until Ctrl+C (default 0)
//   WARM_S       seconds of clean traffic before fraud is injected (default 600; use 60 for a demo)
//   SPIKE_P      probability that a post-warm-up event is an amount spike (default 0.003)
//   BURST_PER_S  expected burst incidents per second (default 0.02)
// The label / incidentId fields are ground truth for evaluation; the scorer never reads them.

load("mongo/lib/synthetic.js");
const d = db.getSiblingDB(process.env.DB_NAME || "fraudlab");
const env = (k, dflt) => (process.env[k] !== undefined && process.env[k] !== "" ? Number(process.env[k]) : dflt);
const USERS = env("USERS", 500), SEED = env("SEED", Math.floor(Math.random() * 2 ** 31)),
      DURATION_S = env("DURATION_S", 0), WARM_S = env("WARM_S", 600),
      SPIKE_P = env("SPIKE_P", 0.003), BURST_PER_S = env("BURST_PER_S", 0.02), TICK_MS = 100;

const rng = makeRng(SEED);
const users = makeUsers(USERS, rng);
const totalRate = users.reduce((s, u) => s + u.rate, 0);
const cumulative = []; users.reduce((acc, u, i) => (cumulative[i] = acc + u.rate), 0);
function pickUser() {                                   // pick a user in proportion to their rate
  const x = rng.next() * totalRate;
  let lo = 0, hi = cumulative.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] < x) lo = mid + 1; else hi = mid; }
  return users[lo];
}
const makeDoc = (user, ts, label, amount, incidentId) => ({
  txId: new ObjectId().toString(), userId: user.id, amount: amount, ts: ts,
  ingestedAt: new Date(), label: label, incidentId: incidentId || null,
  deviceId: user.deviceId, country: user.homeCountry, homeCountry: user.homeCountry });

const pendingBurst = [];                                 // burst events waiting for their send time
let incidentSeq = 0;
function scheduleBurst(now) {
  const user = users[rng.int(0, users.length - 1)];
  const incidentId = SEED + "-" + incidentSeq++;
  let due = now;
  for (let i = rng.int(10, 15); i > 0; i--) { pendingBurst.push({ due: due, user: user, incidentId: incidentId }); due += rng.exp(350); }
}

const sent = { normal: 0, spike: 0, burst: 0 };
const started = Date.now();
print("generator: " + USERS + " users, ~" + totalRate.toFixed(0) + " events/s, seed " + SEED);

while (true) {
  const tickStart = Date.now(), elapsedS = (tickStart - started) / 1000;
  if (DURATION_S && elapsedS >= DURATION_S && pendingBurst.length === 0) break;
  const fraudOn = elapsedS >= WARM_S && !(DURATION_S && elapsedS >= DURATION_S);
  const docs = [];

  // Normal traffic: number of events this tick ~ Poisson(totalRate * tick)
  if (!(DURATION_S && elapsedS >= DURATION_S)) {
    const lambda = totalRate * TICK_MS / 1000;
    let k = 0;
    for (let p = Math.exp(-lambda), s = p, u = rng.next(); u > s; ) { k++; p *= lambda / k; s += p; }
    for (let i = 0; i < k; i++) {
      const user = pickUser();
      const ts = new Date(tickStart - TICK_MS + Math.floor(i / Math.max(k, 1) * TICK_MS));
      if (fraudOn && rng.next() < SPIKE_P) { docs.push(makeDoc(user, ts, "spike", spikeAmount(user, rng))); sent.spike++; }
      else { docs.push(makeDoc(user, ts, null, normalAmount(user, rng))); sent.normal++; }
    }
    if (fraudOn && rng.next() < BURST_PER_S * TICK_MS / 1000) scheduleBurst(tickStart);
  }

  // Burst events whose time has come (kept in schedule order)
  const ready = pendingBurst.filter(b => b.due <= tickStart);
  if (ready.length) {
    pendingBurst.splice(0, pendingBurst.length, ...pendingBurst.filter(b => b.due > tickStart));
    for (const b of ready) { docs.push(makeDoc(b.user, new Date(), "burst", normalAmount(b.user, rng), b.incidentId)); sent.burst++; }
  }
  if (docs.length) d.tx_inbox.insertMany(docs, { ordered: true });
  const wait = TICK_MS - (Date.now() - tickStart);
  if (wait > 0) sleep(wait);
}
print("generator finished " + JSON.stringify(sent) + " in " + ((Date.now() - started) / 1000).toFixed(1) + "s");
