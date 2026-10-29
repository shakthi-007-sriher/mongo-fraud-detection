'use strict';

/**
 * JavaScript REFERENCE model of the scoring formula. The live system computes the same formula
 * inside MongoDB (mongo/lib/pipelines.js); this copy exists for the offline simulation and as
 * the oracle the pipeline test compares against.
 *
 * Model
 * -----
 * For each incoming event (user u, amount x) the detector looks at u's recent history:
 *
 *   baseline  : unflagged events of u in the last `baselineWindowS` seconds
 *               -> n, mean and sample standard deviation of ln(amount)
 *   velocity  : events of u (flagged or not) in the last `burstWindowS` seconds
 *
 *   z  = (ln x - meanLog) / max(sdLog, sdFloor)          amount deviation in SDs
 *   A  = clamp((z - zLow) / (zHigh - zLow), 0, 1)         amount component
 *   V  = clamp((b - burstSoft) / (burstHard - burstSoft), 0, 1)   b = recent count incl. this event
 *   risk = 100 * (1 - (1 - A) * (1 - V))                  noisy-OR of both components
 *   flagged = risk >= scoreAlert
 *
 * Amounts are modelled on the log scale because transaction amounts are right-skewed;
 * a z-score on raw amounts would over-flag the natural tail of normal behaviour.
 */

const DEFAULTS = {
  baselineWindowS: 600,
  burstWindowS: 5,
  minHistory: 20,
  sdFloor: 0.10,
  zLow: 2.5,
  zHigh: 6.0,
  burstSoft: 4,
  burstHard: 8,
  scoreAlert: 60,
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function emptyStats() {
  return { n: 0, meanLog: null, sdLog: null, varLog: null, burst: 0 };
}

/**
 * Turn baseline statistics + the current event into a risk verdict.
 * @param {number} amount  transaction amount (> 0)
 * @param {{n:number, meanLog:?number, sdLog:?number, burst:number}} stats
 *        `burst` = number of the user's events in the burst window, NOT counting this one
 */
function computeRisk(amount, stats, p = DEFAULTS) {
  const x = Math.max(Number(amount), 0.01);
  const burstCount = (stats.burst || 0) + 1;

  let z = 0;
  let warm = true;
  if (stats.n >= p.minHistory && stats.meanLog != null) {
    warm = false;
    const sd = Math.max(stats.sdLog ?? 0, p.sdFloor);
    z = (Math.log(x) - stats.meanLog) / sd;
  }

  const A = clamp01((z - p.zLow) / (p.zHigh - p.zLow));
  const V = clamp01((burstCount - p.burstSoft) / (p.burstHard - p.burstSoft));
  const risk = 100 * (1 - (1 - A) * (1 - V));
  const flagged = risk >= p.scoreAlert;

  const reasons = [];
  if (A >= 0.3) reasons.push('AMOUNT_SPIKE');
  if (V >= 0.3) reasons.push('VELOCITY_BURST');

  return {
    risk,
    flagged,
    z,
    amountComponent: A,
    velocityComponent: V,
    burstCount,
    warm,
    reasons,
    varLog: stats.varLog ?? (stats.sdLog != null ? stats.sdLog ** 2 : null),
  };
}

/**
 * JavaScript reference implementation of the baseline $group stage, used by the
 * offline simulation. `items` = [{ t: epochMs, logAmt: number, flagged: boolean }, ...]
 * for ONE user. Semantics match statsStages() in mongo/lib/pipelines.js:
 *   window = [now - baselineWindowS, now]; flagged events excluded from the amount
 *   statistics (when excludeFlagged) but still counted for velocity.
 */
function statsFromWindow(items, nowMs, p = DEFAULTS, excludeFlagged = true) {
  const lo = nowMs - p.baselineWindowS * 1000;
  const burstLo = nowMs - p.burstWindowS * 1000;
  let n = 0;
  let sum = 0;
  let burst = 0;
  const used = [];
  for (const it of items) {
    if (it.t < lo || it.t > nowMs) continue;
    if (it.t >= burstLo) burst++;
    if (excludeFlagged && it.flagged) continue;
    n++;
    sum += it.logAmt;
    used.push(it.logAmt);
  }
  if (n === 0) return { ...emptyStats(), burst };
  const meanLog = sum / n;
  let ss = 0;
  for (const v of used) ss += (v - meanLog) ** 2;
  const varLog = n > 1 ? ss / (n - 1) : null; // sample variance, like $stdDevSamp
  return { n, meanLog, sdLog: varLog == null ? null : Math.sqrt(varLog), varLog, burst };
}

module.exports = { DEFAULTS, emptyStats, computeRisk, statsFromWindow };
