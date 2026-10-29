// Detection quality and latency of a live run, computed by two aggregations on tx_scores.
//   mongosh --file mongo/05_evaluate.js                      (last 30 minutes)
//   $env:MINUTES=15; mongosh --file mongo/05_evaluate.js     (PowerShell: last 15 minutes)
// Ground truth is the `label` field written by the generator. Requires MongoDB 7.0+.

const d = db.getSiblingDB(process.env.DB_NAME || "fraudlab");
const since = process.env.SINCE ? new Date(process.env.SINCE)
                                : new Date(Date.now() - (Number(process.env.MINUTES) || 30) * 60000);
const inWindow = { $match: { ts: { $gte: since } } };
const count = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
const ratio = (a, b) => ({ $cond: [{ $gt: [b, 0] }, { $divide: [a, b] }, null] });

// Part 1: confusion matrix, spike recall, throughput and latency percentiles in one $group.
const m = d.tx_scores.aggregate([
  inWindow,
  { $set: { pos: { $eq: [{ $type: "$label" }, "string"] } } },
  { $group: { _id: null,
      events: { $sum: 1},
      tp: count({ $and: ["$pos", "$flagged"] }),        fp: count({ $and: [{ $not: ["$pos"] }, "$flagged"] }),
      fn: count({ $and: ["$pos", { $not: ["$flagged"] }] }), tn: count({ $and: [{ $not: ["$pos"] }, { $not: ["$flagged"] }] }),
      spikes: count({ $eq: ["$label", "spike"] }),
      spikesHit: count({ $and: [{ $eq: ["$label", "spike"] }, "$flagged"] }),
      spikesReady: count({ $and: [{ $eq: ["$label", "spike"] }, { $not: ["$warm"] }] }),
      spikesReadyHit: count({ $and: [{ $eq: ["$label", "spike"] }, { $not: ["$warm"] }, "$flagged"] }),
      firstIn: { $min: "$ingestedAt" }, lastIn: { $max: "$ingestedAt" },
      lat: { $percentile: { input: "$latencyMs", p: [0.5, 0.95, 0.99], method: "approximate" } } } },
  { $set: { precision: ratio("$tp", { $add: ["$tp", "$fp"] }), recall: ratio("$tp", { $add: ["$tp", "$fn"] }),
            fpr: ratio("$fp", { $add: ["$fp", "$tn"] }),
            spanS: { $divide: [{ $subtract: ["$lastIn", "$firstIn"] }, 1000] } } },
  { $set: { f1: { $cond: [{ $gt: [{ $add: ["$precision", "$recall"] }, 0] },
                          { $divide: [{ $multiply: [2, "$precision", "$recall"] }, { $add: ["$precision", "$recall"] }] }, null] },
            throughput: ratio("$events", "$spanS") } },
]).toArray()[0];

if (!m) { print("no scored events in the selected period"); quit(); }

// Part 2: burst incidents. Number each incident's events in order, then find the first flagged one.
const b = d.tx_scores.aggregate([
  inWindow, { $match: { label: "burst" } },
  { $setWindowFields: { partitionBy: "$incidentId", sortBy: { ts: 1, ingestedAt: 1 },
                        output: { idx: { $documentNumber: {} } } } },
  { $group: { _id: "$incidentId", firstFlagIdx: { $min: { $cond: ["$flagged", "$idx", null] } } } },
  { $group: { _id: null, incidents: { $sum: 1 },
              detected: count({ $ne: [{ $type: "$firstFlagIdx" }, "null"] }),
              meanFirstFlag: { $avg: "$firstFlagIdx" } } },
]).toArray()[0] || { incidents: 0, detected: 0, meanFirstFlag: null };

const pct = (v) => (v == null ? "n/a" : (v * 100).toFixed(2) + "%");
const num = (v, k) => (v == null ? "n/a" : v.toFixed(k));
print("| Metric | Value |\n| --- | --- |");
print("| Events scored | " + m.events + " |");
print("| Throughput (events/s over ingest span) | " + num(m.throughput, 1) + " |");
print("| TP / FP / FN / TN | " + [m.tp, m.fp, m.fn, m.tn].join(" / ") + " |");
print("| Precision | " + pct(m.precision) + " |");
print("| Recall (all labelled events) | " + pct(m.recall) + " |");
print("| F1 | " + pct(m.f1) + " |");
print("| False-positive rate | " + pct(m.fpr) + " |");
print("| Spike recall (all / baseline ready) | " + pct(m.spikes ? m.spikesHit / m.spikes : null) + " / " +
      pct(m.spikesReady ? m.spikesReadyHit / m.spikesReady : null) + " |");
print("| Burst incidents detected | " + b.detected + " of " + b.incidents + " |");
print("| Mean events into a burst before first flag | " + num(b.meanFirstFlag, 2) + " |");
print("| Latency p50 / p95 / p99 (ms) | " + m.lat.join(" / ") + " |");
