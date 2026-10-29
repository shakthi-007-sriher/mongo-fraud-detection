// One-time, repeatable database setup.
//   mongosh --file mongo/01_setup.js          (run from the project folder)
//
// Creates: a validated inbox, the time-series history, the scores collection, the dashboard
// views, TTL indexes and the scoring parameters document. Safe to run again.

load("mongo/lib/pipelines.js");
const d = db.getSiblingDB(process.env.DB_NAME || "fraudlab");
const have = new Set(d.getCollectionNames());

// 1. Inbox: regular collection watched by the change stream, guarded by a JSON-schema validator.
//    (Time-series collections do not support change streams, so ingestion goes through here.)
const inboxValidator = { $jsonSchema: {
  bsonType: "object",
  required: ["txId", "userId", "amount", "ts", "ingestedAt"],
  properties: {
    txId:       { bsonType: "string" },
    userId:     { bsonType: "string" },
    amount:     { bsonType: ["double", "int", "long", "decimal"], minimum: 0, exclusiveMinimum: true },
    ts:         { bsonType: "date" },
    ingestedAt: { bsonType: "date" },
    label:      { enum: [null, "spike", "burst"], description: "ground truth, evaluation only" },
  } } };
if (!have.has("tx_inbox")) d.createCollection("tx_inbox", { validator: inboxValidator });
else d.runCommand({ collMod: "tx_inbox", validator: inboxValidator });
d.tx_inbox.createIndex({ ingestedAt: 1 }, { expireAfterSeconds: 3600 });          // keep 1 hour

// 2. History: time-series collection. meta.userId buckets each user's events together.
if (!have.has("tx_history"))
  d.createCollection("tx_history", {
    timeseries: { timeField: "ts", metaField: "meta", granularity: "seconds" },
    expireAfterSeconds: 86400,                                                       // keep 24 hours
  });
d.tx_history.createIndex({ "meta.userId": 1, ts: -1 });                              // baseline access path

// 3. Scores: one verdict per event. The unique txId makes a replayed event detectable.
if (!have.has("tx_scores")) d.createCollection("tx_scores");
d.tx_scores.createIndex({ txId: 1 }, { unique: true });
d.tx_scores.createIndex({ ts: -1 }, { expireAfterSeconds: 86400 });
d.tx_scores.createIndex({ flagged: 1, ts: -1 });
d.tx_scores.createIndex({ userId: 1, ts: -1 });                                      // dashboard: one user's history

// 4. Detector bookkeeping and parameters. The scoring parameters live in the database,
//    so they can be changed with one update and no code change.
if (!have.has("pipeline_meta")) d.createCollection("pipeline_meta");
d.getCollection("config").replaceOne({ _id: "scoring" }, Object.assign({ _id: "scoring" }, DEFAULT_PARAMS), { upsert: true });

// 5. Dashboard views: the web page only reads these. $$NOW makes the 60-second windows slide.
const view = (name, source, pipeline) => {
  if (d.getCollectionNames().includes(name)) d.getCollection(name).drop();
  d.createView(name, source, pipeline);
};
const last60 = { $match: { $expr: { $gte: ["$ts", { $subtract: ["$$NOW", 60000] }] } } };

view("v_feed", "tx_scores", [
  { $sort: { ts: -1 } }, { $limit: 40 },
  { $project: { _id: 0, txId: 1, userId: 1, amount: 1, ts: 1, risk: 1, flagged: 1, reasons: 1 } } ]);

view("tx_alerts", "tx_scores", [ { $match: { flagged: true } } ]);                   // alerts = flagged scores

view("v_alerts", "tx_alerts", [
  { $sort: { ts: -1 } }, { $limit: 15 },
  { $project: { _id: 0, txId: 1, userId: 1, amount: 1, ts: 1, risk: 1, reasons: 1, z: 1, burst: 1 } } ]);

view("v_per_second", "tx_scores", [ last60,
  { $group: { _id: { $dateTrunc: { date: "$ts", unit: "second" } },
              total: { $sum: 1 }, flagged: { $sum: { $cond: ["$flagged", 1, 0] } } } },
  { $sort: { _id: 1 } },
  { $project: { _id: 0, t: "$_id", total: 1, flagged: 1 } } ]);

view("v_last_minute", "tx_scores", [ last60,
  { $group: { _id: null, events: { $sum: 1 }, flagged: { $sum: { $cond: ["$flagged", 1, 0] } },
              avgLatencyMs: { $avg: "$latencyMs" }, maxLatencyMs: { $max: "$latencyMs" } } },
  { $project: { _id: 0, events: 1, flagged: 1, maxLatencyMs: 1,
                eventsPerSecond: { $round: [{ $divide: ["$events", 60] }, 1] },
                avgLatencyMs: { $round: ["$avgLatencyMs", 0] } } } ]);

print("database '" + d.getName() + "' is ready:");
printjson(d.getCollectionInfos({}, { nameOnly: true }).map(c => c.name + " (" + c.type + ")").sort());
