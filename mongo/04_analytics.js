// Windowed and statistical analytics, all computed inside MongoDB.
//   mongosh --file mongo/04_analytics.js
// Requires MongoDB 7.0+ ($percentile). Run it while, or after, the pipeline has processed data.

load("mongo/lib/pipelines.js");
const d = db.getSiblingDB(process.env.DB_NAME || "fraudlab");
const P = Object.assign({}, DEFAULT_PARAMS, d.getCollection("config").findOne({ _id: "scoring" }));
const show = (title, rows) => { print("\n== " + title); console.table(rows); };

// 1. Per-user profile: count, mean, standard deviation, variance, median and 95th percentile
//    of the amount. Materialised into user_profiles with $merge (re-running refreshes it).
d.tx_history.aggregate([
  { $group: { _id: "$meta.userId", events: { $sum: 1 }, flagged: { $sum: { $cond: ["$flagged", 1, 0] } },
              meanAmount: { $avg: "$amount" }, sdAmount: { $stdDevSamp: "$amount" },
              pcts: { $percentile: { input: "$amount", p: [0.5, 0.95], method: "approximate" } } } },
  { $set: { varAmount: { $pow: ["$sdAmount", 2] }, median: { $first: "$pcts" }, p95: { $last: "$pcts" } } },
  { $project: { _id: 1, events: 1, flagged: 1, meanAmount: { $round: ["$meanAmount", 2] },
                sdAmount: { $round: ["$sdAmount", 2] }, varAmount: { $round: ["$varAmount", 1] },
                median: { $round: ["$median", 2] }, p95: { $round: ["$p95", 2] } } },
  { $merge: { into: "user_profiles", on: "_id", whenMatched: "replace", whenNotMatched: "insert" } },
]);
show("user_profiles: five busiest users", d.user_profiles.find().sort({ events: -1 }).limit(5).toArray());

// 2. Rolling mean / SD / variance for the busiest user ($setWindowFields, 600 s sliding window).
const top = d.user_profiles.find().sort({ events: -1 }).limit(1).toArray()[0];
if (top) show("rolling statistics for " + top._id + " (latest 8 events)",
  d.tx_history.aggregate(rollingPipeline(top._id, new Date(0), P, 8)).toArray());

// 3. Alerts per minute with a 5-minute moving average ($dateTrunc + $setWindowFields).
show("flagged events per minute and moving average", d.tx_scores.aggregate([
  { $group: { _id: { $dateTrunc: { date: "$ts", unit: "minute" } }, events: { $sum: 1 },
              flagged: { $sum: { $cond: ["$flagged", 1, 0] } } } },
  { $setWindowFields: { sortBy: { _id: 1 },
      output: { movingAvgFlagged: { $avg: "$flagged", window: { documents: [-4, 0] } } } } },
  { $project: { _id: 0, minute: "$_id", events: 1, flagged: 1, movingAvgFlagged: { $round: ["$movingAvgFlagged", 2] } } },
  { $sort: { minute: -1 } }, { $limit: 10 },
]).toArray());

// 4. Distribution of risk scores ($bucket).
show("risk score distribution", d.tx_scores.aggregate([
  { $bucket: { groupBy: "$risk", boundaries: [0, 10, 25, 40, 60, 80, 101], default: "other",
               output: { events: { $sum: 1 }, flagged: { $sum: { $cond: ["$flagged", 1, 0] } } } } },
]).toArray());

// 5. Users with the most alerts, and why they were flagged.
show("users with most alerts", d.tx_alerts.aggregate([
  { $unwind: "$reasons" },
  { $group: { _id: { userId: "$userId", reason: "$reasons" }, alerts: { $sum: 1 }, maxRisk: { $max: "$risk" } } },
  { $sort: { alerts: -1 } }, { $limit: 8 },
  { $project: { _id: 0, userId: "$_id.userId", reason: "$_id.reason", alerts: 1, maxRisk: 1 } },
]).toArray());
