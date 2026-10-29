// Real-time detector: a Change Stream on tx_inbox triggers one scoring aggregation per event.
//   mongosh --file mongo/02_detector.js       (leave it running; Ctrl+C to stop)
//
// The script only moves data. The score itself is computed inside MongoDB by the pipeline in
// mongo/lib/pipelines.js.

load("mongo/lib/pipelines.js");
const d = db.getSiblingDB(process.env.DB_NAME || "fraudlab");
const loadParams = () => Object.assign({}, DEFAULT_PARAMS, d.getCollection("config").findOne({ _id: "scoring" }));
let P = loadParams();                              // re-read every 5 s, so dashboard changes apply live
let paramsLoadedAt = Date.now();
const TOKEN_ID = "detectorResumeToken";

let handled = 0, flagged = 0;

function handle(ev) {
  if (Date.now() - paramsLoadedAt > 5000) { P = loadParams(); paramsLoadedAt = Date.now(); }   // live settings
  // 1 + 2. Baseline statistics and risk score, in one aggregation on the time-series collection.
  const v = d.tx_history.aggregate(scoringPipeline(ev, P)).toArray()[0];

  // 3. Store the verdict. The unique index on txId rejects a replayed event (E11000), which is
  //    what makes recovery after a crash safe.
  try { d.tx_scores.insertOne(v); }
  catch (e) { if (e.code === 11000) return; throw e; }

  // 4. Add the event to the time-series history, so later baselines include it.
  d.tx_history.insertOne({ ts: v.ts, meta: { userId: v.userId }, amount: v.amount,
                           txId: v.txId, flagged: v.flagged, risk: v.risk, label: v.label });

  handled++;
  if (v.flagged) {
    flagged++;
    print("ALERT " + v.userId + " amount=" + v.amount.toFixed(2) + " risk=" + v.risk +
          " [" + v.reasons.join(",") + "] latency=" + v.latencyMs + "ms");
  }
}

function run(resumeToken) {
  const cs = d.tx_inbox.watch([{ $match: { operationType: "insert" } }],
                              resumeToken ? { resumeAfter: resumeToken } : {});
  print(resumeToken ? "change stream resumed" : "change stream started");
  while (!cs.isClosed()) {
    let change;
    while ((change = cs.tryNext()) !== null) {
      handle(change.fullDocument);
      if (handled % 50 === 0)
        d.pipeline_meta.updateOne({ _id: TOKEN_ID },
          { $set: { token: cs.getResumeToken(), savedAt: new Date() } }, { upsert: true });
      if (handled > 0 && handled % 1000 === 0) print("processed " + handled + " events, " + flagged + " flagged");
    }
    sleep(20);                                    // nothing waiting: pause briefly
  }
}

const saved = d.pipeline_meta.findOne({ _id: TOKEN_ID });
try { run(saved ? saved.token : null); }
catch (e) {
  // The saved token may have left the oplog (286 = ChangeStreamHistoryLost, 280 = fatal error).
  if (saved && (e.code === 286 || e.code === 280)) {
    print("saved resume token is no longer valid; starting a fresh change stream");
    d.pipeline_meta.deleteOne({ _id: TOKEN_ID });
    run(null);
  } else throw e;
}
