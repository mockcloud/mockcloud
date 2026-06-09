// services/cloudwatch.js — CloudWatch metrics. The AWS SDK v3 CloudWatch client
// speaks awsJson1.0 with X-Amz-Target: GraniteServiceVersion20100801.<Op>.
// Backs onto the in-memory ring buffer in store.js (store.cloudwatch.metrics +
// putMetric). Distinct from routes/cloudwatch.js, which is the UI plane.
import { store } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

export function handler(req, res) {
  const op   = (req.headers['x-amz-target'] || '').split('.')[1] || '';
  const body = req.parsedBody || {};
  switch (op) {
    case 'PutMetricData':       return putMetricData(res, body);
    case 'GetMetricStatistics': return getMetricStatistics(res, body);
    case 'ListMetrics':         return listMetrics(res, body);
    default:                    return errorJson(res, 400, 'UnknownOperationException', `Unknown CloudWatch op: ${op}`);
  }
}

function putMetricData(res, body) {
  const ns = body.Namespace || '';
  for (const d of body.MetricData || []) {
    store.putMetric(ns, d.MetricName, Number(d.Value ?? 0), d.Unit || 'None');
  }
  return jsonResponse(res, 200, {});
}

function getMetricStatistics(res, body) {
  const points = store.cloudwatch.metrics[`${body.Namespace}/${body.MetricName}`] || [];
  const start  = toMs(body.StartTime) || 0;
  const end    = toMs(body.EndTime) || Date.now();
  const period = (Number(body.Period) || 60) * 1000;
  const stats  = body.Statistics && body.Statistics.length ? body.Statistics : ['Average'];

  const buckets = new Map();
  let unit = 'None';
  for (const p of points) {
    if (p.t < start || p.t > end) continue;
    unit = p.unit || unit;
    const b = Math.floor(p.t / period) * period;
    (buckets.get(b) || buckets.set(b, []).get(b)).push(p.v);
  }
  const Datapoints = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, vals]) => {
    const dp = { Timestamp: Math.floor(b / 1000), Unit: unit };   // awsJson timestamps are epoch seconds
    if (stats.includes('Sum'))         dp.Sum = vals.reduce((a, c) => a + c, 0);
    if (stats.includes('Average'))     dp.Average = vals.reduce((a, c) => a + c, 0) / vals.length;
    if (stats.includes('Minimum'))     dp.Minimum = Math.min(...vals);
    if (stats.includes('Maximum'))     dp.Maximum = Math.max(...vals);
    if (stats.includes('SampleCount')) dp.SampleCount = vals.length;
    return dp;
  });
  return jsonResponse(res, 200, { Label: body.MetricName, Datapoints });
}

function listMetrics(res, body) {
  const Metrics = Object.keys(store.cloudwatch.metrics).map(key => {
    const i = key.indexOf('/');
    return { Namespace: key.slice(0, i), MetricName: key.slice(i + 1), Dimensions: [] };
  }).filter(m => !body.Namespace || m.Namespace === body.Namespace);
  return jsonResponse(res, 200, { Metrics });
}

// awsJson1.0 serializes timestamps as epoch seconds (number).
function toMs(t) {
  if (t == null) return 0;
  if (typeof t === 'number') return t * 1000;
  const n = Number(t);
  return Number.isNaN(n) ? (Date.parse(t) || 0) : n * 1000;
}
