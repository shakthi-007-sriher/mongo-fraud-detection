// A small interpreter for the aggregation operators used by mongo/lib/pipelines.js.
// It exists only so the test can run the scoring pipeline without a MongoDB server.
// It checks that the pipeline encodes the intended formula; it is NOT evidence about real
// server behaviour. Missing fields are `undefined`, BSON null is `null`.

const isNil = (v) => v === undefined || v === null;
const bsonType = (v) => (v === undefined ? 'missing' : v === null ? 'null' : v instanceof Date ? 'date'
  : typeof v === 'number' ? 'double' : typeof v === 'boolean' ? 'bool' : typeof v === 'string' ? 'string'
  : Array.isArray(v) ? 'array' : 'object');
const getPath = (doc, p) => p.split('.').reduce((o, k) => (isNil(o) ? undefined : o[k]), doc);
const num = (v) => (v instanceof Date ? v.getTime() : v);

function ev(e, doc, vars) {
  if (typeof e === 'string') {
    if (e === '$$NOW') return vars.NOW;
    if (e.startsWith('$$')) throw new Error('unsupported variable ' + e);
    return e.startsWith('$') ? getPath(doc, e.slice(1)) : e;
  }
  if (Array.isArray(e)) return e.map((x) => ev(x, doc, vars));
  if (e === null || typeof e !== 'object' || e instanceof Date) return e;
  const keys = Object.keys(e);
  if (keys.length === 1 && keys[0].startsWith('$')) return op(keys[0], e[keys[0]], doc, vars);
  const out = {};
  for (const k of keys) out[k] = ev(e[k], doc, vars);
  return out;
}

function op(name, arg, doc, vars) {
  const E = (x) => ev(x, doc, vars);
  const args = () => (Array.isArray(arg) ? arg.map(E) : [E(arg)]);
  switch (name) {
    case '$literal': return arg;
    case '$cond': { const [c, t, f] = arg; return E(c) ? E(t) : E(f); }
    case '$ifNull': { const a = E(arg[0]); return isNil(a) ? E(arg[1]) : a; }
    case '$and': return arg.every((x) => !!E(x));
    case '$or': return arg.some((x) => !!E(x));
    case '$not': return !E(arg[0]);
    case '$eq': { const [a, b] = args(); return a === b || (a instanceof Date && b instanceof Date && +a === +b); }
    case '$ne': { const [a, b] = args(); return !(a === b); }
    case '$gte': { const [a, b] = args(); return num(a) >= num(b); }
    case '$gt': { const [a, b] = args(); return num(a) > num(b); }
    case '$lt': { const [a, b] = args(); return num(a) < num(b); }
    case '$lte': { const [a, b] = args(); return num(a) <= num(b); }
    case '$type': return bsonType(E(arg));
    case '$max': case '$min': {
      const v = args().filter((x) => !isNil(x));
      return v.length ? (name === '$max' ? Math.max(...v) : Math.min(...v)) : null;
    }
    case '$add': case '$multiply': case '$subtract': case '$divide': case '$pow': {
      const a = args();
      if (a.some(isNil)) return null;
      const n = a.map(num);
      if (name === '$add') return n.reduce((s, x) => s + x, 0);
      if (name === '$multiply') return n.reduce((s, x) => s * x, 1);
      if (name === '$subtract') return n[0] - n[1];
      if (name === '$divide') return n[0] / n[1];
      return n[0] ** n[1];
    }
    case '$ln': { const [a] = args(); return isNil(a) ? null : Math.log(a); }
    case '$round': { const [a, p] = args(); if (isNil(a)) return null; const f = 10 ** p; return Math.round(a * f) / f; }
    case '$concatArrays': return [].concat(...args());
    case '$first': { const [a] = args(); return isNil(a) || !a.length ? null : a[0]; }
    case '$mergeObjects': return Object.assign({}, ...args().filter((x) => !isNil(x)));
    default: throw new Error('operator not supported by the test interpreter: ' + name);
  }
}

function accumulate(spec, docs, vars) {
  const [[name, arg]] = Object.entries(spec);
  const vals = docs.map((d) => ev(arg, d, vars));
  const nums = vals.filter((v) => typeof v === 'number');
  if (name === '$sum') return vals.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
  if (name === '$avg') return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
  if (name === '$stdDevSamp') {
    if (nums.length < 2) return null;
    const m = nums.reduce((s, v) => s + v, 0) / nums.length;
    return Math.sqrt(nums.reduce((s, v) => s + (v - m) ** 2, 0) / (nums.length - 1));
  }
  throw new Error('accumulator not supported: ' + name);
}

function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    const v = getPath(doc, k);
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      return Object.entries(cond).every(([o, x]) => (o === '$gte' ? num(v) >= num(x) : o === '$lte' ? num(v) <= num(x) : (() => { throw new Error(o); })()));
    }
    return v === cond;
  });
}

function runStage(stage, docs, vars) {
  const [[name, spec]] = Object.entries(stage);
  switch (name) {
    case '$match': return docs.filter((d) => matches(d, spec));
    case '$facet': {
      const out = {};
      for (const [k, sub] of Object.entries(spec)) out[k] = runPipeline(sub, docs, vars);
      return [out];
    }
    case '$group': {
      const { _id, ...accs } = spec;
      if (_id !== null) throw new Error('only _id: null is supported');
      if (!docs.length) return [];
      const o = { _id: null };
      for (const [k, a] of Object.entries(accs)) o[k] = accumulate(a, docs, vars);
      return [o];
    }
    case '$replaceWith': return docs.map((d) => ev(spec, d, vars));
    case '$set': return docs.map((d) => { const o = { ...d }; for (const [k, e] of Object.entries(spec)) o[k] = ev(e, d, vars); return o; });
    case '$project': return docs.map((d) => {
      const o = {};
      for (const [k, v] of Object.entries(spec)) {
        if (v === 0) continue;
        if (v === 1) { if (d[k] !== undefined) o[k] = d[k]; } else o[k] = ev(v, d, vars);
      }
      return o;
    });
    default: throw new Error('stage not supported by the test interpreter: ' + name);
  }
}

function runPipeline(stages, docs, vars) {
  return stages.reduce((cur, st) => runStage(st, cur, vars), docs);
}

module.exports = { runPipeline };
