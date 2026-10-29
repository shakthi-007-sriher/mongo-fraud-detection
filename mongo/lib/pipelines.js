// Aggregation pipelines: the scoring model expressed entirely as MongoDB stages.
//
// This file is loaded by mongosh (load("mongo/lib/pipelines.js")) and, for the tests and the
// dashboard, by Node (require). It contains only data (pipeline arrays), no I/O.

var DEFAULT_PARAMS = {
  baselineWindowS: 600, // per-user baseline window
  burstWindowS: 5,      // window for the velocity count
  minHistory: 20,       // baseline events needed before amount scoring
  sdFloor: 0.10,        // minimum SD of ln(amount)
  zLow: 2.5,            // z where the amount component starts to rise
  zHigh: 6.0,           // z where it saturates
  burstSoft: 4,         // events in the burst window where velocity starts to rise
  burstHard: 8,         // events where it saturates
  scoreAlert: 60,       // risk >= this is flagged
};

// Stage group 1: attach the user's baseline statistics to the event.
// Runs on the time-series collection BEFORE the event is stored, so an event never
// contributes to its own baseline. $facet always returns one document, even when the user
// has no history yet, which is what lets the first event of a new user be scored.
function statsStages(ev, p) {
  var winStart = new Date(ev.ts.getTime() - p.baselineWindowS * 1000);
  var burstStart = new Date(ev.ts.getTime() - p.burstWindowS * 1000);
  var cleanLog = { $cond: [{ $eq: ["$flagged", true] }, null, { $ln: "$amount" }] };
  return [
    { $match: { "meta.userId": ev.userId, ts: { $gte: winStart, $lte: ev.ts } } },
    { $facet: { stats: [ { $group: {
        _id: null,
        n:       { $sum: { $cond: [{ $eq: ["$flagged", true] }, 0, 1] } },
        meanLog: { $avg: cleanLog },          // flagged events give null and are ignored
        sdLog:   { $stdDevSamp: cleanLog },
        burst:   { $sum: { $cond: [{ $gte: ["$ts", burstStart] }, 1, 0] } },  // flagged ones count
    } } ] } },
    { $replaceWith: { $mergeObjects: [
        { $literal: {
            txId: ev.txId, userId: ev.userId, ts: ev.ts, amount: ev.amount,
            ingestedAt: ev.ingestedAt, label: ev.label == null ? null : ev.label,
            incidentId: ev.incidentId == null ? null : ev.incidentId,
            deviceId: ev.deviceId == null ? null : ev.deviceId,
            country: ev.country == null ? null : ev.country,
            homeCountry: ev.homeCountry == null ? null : ev.homeCountry } },
        { $ifNull: [{ $first: "$stats" }, { n: 0, burst: 0 }] },
    ] } },
  ];
}

// Stage group 2: turn baseline statistics into a risk verdict. Pure arithmetic, no I/O.
//   z    = (ln x - meanLog) / max(sdLog, sdFloor)
//   A    = clamp((z - zLow) / (zHigh - zLow), 0, 1)
//   V    = clamp((burstCount - burstSoft) / (burstHard - burstSoft), 0, 1)
//   risk = 100 * (1 - (1 - A)(1 - V));  flagged = risk >= scoreAlert
function riskStages(p) {
  var clamp01 = function (e) { return { $min: [1, { $max: [0, e] }] }; };
  return [
    { $set: {
        x:   { $max: ["$amount", 0.01] },
        sd:  { $max: [{ $ifNull: ["$sdLog", 0] }, p.sdFloor] },
        burstCount: { $add: [{ $ifNull: ["$burst", 0] }, 1] },     // includes this event
        warm: { $or: [{ $lt: ["$n", p.minHistory] }, { $ne: [{ $type: "$meanLog" }, "double"] }] },
    } },
    { $set: { z: { $cond: ["$warm", 0,
        { $divide: [{ $subtract: [{ $ln: "$x" }, "$meanLog"] }, "$sd"] }] } } },
    { $set: {
        A: clamp01({ $divide: [{ $subtract: ["$z", p.zLow] }, p.zHigh - p.zLow] }),
        V: clamp01({ $divide: [{ $subtract: ["$burstCount", p.burstSoft] }, p.burstHard - p.burstSoft] }),
    } },
    { $set: { rawRisk: { $multiply: [100,
        { $subtract: [1, { $multiply: [{ $subtract: [1, "$A"] }, { $subtract: [1, "$V"] }] }] }] } } },
    { $project: {
        _id: 0, txId: 1, userId: 1, ts: 1, ingestedAt: 1, label: 1, incidentId: 1,
        deviceId: 1, country: 1, homeCountry: 1,
        amount: "$x",
        risk: { $round: ["$rawRisk", 1] },
        flagged: { $gte: ["$rawRisk", p.scoreAlert] },
        z: { $round: ["$z", 3] },
        burst: "$burstCount",
        baselineN: "$n",
        baselineMeanLog: { $round: ["$meanLog", 3] },
        baselineSdLog: { $round: ["$sdLog", 3] },
        baselineVarLog: { $cond: [{ $eq: [{ $type: "$sdLog" }, "double"] },
                                  { $round: [{ $pow: ["$sdLog", 2] }, 3] }, null] },
        reasons: { $concatArrays: [
          { $cond: [{ $gte: ["$A", 0.3] }, ["AMOUNT_SPIKE"], []] },
          { $cond: [{ $gte: ["$V", 0.3] }, ["VELOCITY_BURST"], []] } ] },
        warm: 1,
        decidedAt: "$$NOW",
        latencyMs: { $subtract: ["$$NOW", "$ingestedAt"] },
    } },
  ];
}

// The full scoring pipeline for one event: run it with db.tx_history.aggregate(...).
function scoringPipeline(ev, p) {
  return statsStages(ev, p).concat(riskStages(p));
}

// Rolling mean / SD / variance of the raw amount per user: a sliding time window.
function rollingPipeline(userId, since, p, limit) {
  var w = { range: [-p.baselineWindowS, "current"], unit: "second" };
  return [
    { $match: { "meta.userId": userId, ts: { $gte: since } } },
    { $setWindowFields: { partitionBy: "$meta.userId", sortBy: { ts: 1 }, output: {
        rollingAvg: { $avg: "$amount", window: w },
        rollingStd: { $stdDevSamp: "$amount", window: w },
    } } },
    { $set: { rollingVar: { $pow: ["$rollingStd", 2] } } },
    { $project: { _id: 0, txId: 1, ts: 1, amount: 1, risk: 1, flagged: 1, rollingAvg: 1, rollingStd: 1, rollingVar: 1 } },
    { $sort: { ts: -1 } }, { $limit: limit || 300 }, { $sort: { ts: 1 } },
  ];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { DEFAULT_PARAMS: DEFAULT_PARAMS, statsStages: statsStages, riskStages: riskStages,
                     scoringPipeline: scoringPipeline, rollingPipeline: rollingPipeline };
}
