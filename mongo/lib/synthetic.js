/**
 * Deterministic synthetic-traffic helpers shared by the live generator and the
 * offline simulation. Seeded so that experiments are reproducible.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  let spare = null;
  return {
    next,
    uniform: (a, b) => a + (b - a) * next(),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    // Box-Muller standard normal
    normal() {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
      }
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    },
    // exponential with the given mean
    exp(mean) {
      let u = 0;
      while (u === 0) u = next();
      return -Math.log(u) * mean;
    },
  };
}

const COUNTRIES = ['IN', 'US', 'GB', 'DE', 'SG', 'AU', 'CA', 'FR'];

/** Each user has a typical amount (median), a spread (sigma of ln amount) and an event rate. */
function makeUsers(n, rng) {
  const users = [];
  for (let i = 0; i < n; i++) {
    users.push({
      id: 'u' + String(i + 1).padStart(4, '0'),
      median: Math.exp(Math.log(40) + 0.7 * rng.normal()), // typical amount, currency units
      sigma: rng.uniform(0.25, 0.45),                      // log-scale spread of normal behaviour
      rate: rng.uniform(0.05, 0.25),                       // events per second
      // Derived from the index (no random draws), so seeded simulations stay reproducible.
      homeCountry: COUNTRIES[(i * 7 + 3) % COUNTRIES.length],
      deviceId: 'dev-' + String(i + 1).padStart(4, '0'),
    });
  }
  return users;
}

const cents = (v) => Math.max(0.01, Math.round(v * 100) / 100);

/** Normal behaviour: log-normal around the user's median. */
function normalAmount(user, rng) {
  return cents(Math.exp(Math.log(user.median) + user.sigma * rng.normal()));
}

/** Amount-spike fraud: 5x to 15x the user's median. */
function spikeAmount(user, rng) {
  return cents(user.median * rng.uniform(5, 15));
}

if (typeof module !== 'undefined' && module.exports) module.exports = { makeRng, makeUsers, normalAmount, spikeAmount, COUNTRIES };
