import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Card, Stat, Breadcrumb } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

// ── Pricing model ───────────────────────────────────────────────────────────
// Approximate on-demand AWS pricing, us-east-1, late 2025. These are
// projections for the Real-AWS column — they are NOT what MockCloud charges
// (it's free). Each service describes its inputs and a `price(u)` that
// returns dollars / month. Free-tier deductions are applied here so the
// breakdown is honest at zero usage.
const HOURS_PER_MONTH = 730;

const SERVICES = [
  {
    key: 'ec2',
    name: 'EC2',
    fields: [
      { key: 'instances', label: 'Instances', kind: 'int', step: 1 },
      { key: 'hourly', label: '$/hour per instance', kind: 'usd', step: 0.001, default: 0.0208 },
    ],
    price: u => num(u.instances) * num(u.hourly) * HOURS_PER_MONTH,
    summary: u => `${num(u.instances)} × $${num(u.hourly).toFixed(4)}/hr × ${HOURS_PER_MONTH}h`,
  },
  {
    key: 's3',
    name: 'S3',
    fields: [
      { key: 'storageGb', label: 'Storage (GB)', kind: 'num', step: 0.1 },
      { key: 'putThousands', label: 'PUT/POST (×1k)', kind: 'num', step: 1 },
      { key: 'getThousands', label: 'GET (×1k)', kind: 'num', step: 1 },
    ],
    price: u =>
      num(u.storageGb) * 0.023      // standard storage
      + num(u.putThousands) * 0.005    // $0.005 per 1k PUTs
      + num(u.getThousands) * 0.0004,  // $0.0004 per 1k GETs
    summary: u => `${num(u.storageGb)} GB stored`,
  },
  {
    key: 'lambda',
    name: 'Lambda',
    fields: [
      { key: 'invocationsM', label: 'Invocations (millions)', kind: 'num', step: 0.1 },
      { key: 'avgMs', label: 'Avg duration (ms)', kind: 'int', step: 10, default: 100 },
      { key: 'memMb', label: 'Memory (MB)', kind: 'int', step: 64, default: 128 },
    ],
    // Free tier: 1M requests + 400,000 GB-seconds per month.
    price: u => {
      const reqs = num(u.invocationsM) * 1_000_000;
      const billedReqs = Math.max(0, reqs - 1_000_000);
      const gbs = reqs * (num(u.avgMs) / 1000) * (num(u.memMb) / 1024);
      const billedGbs = Math.max(0, gbs - 400_000);
      return billedReqs * 0.0000002 + billedGbs * 0.0000166667;
    },
    summary: u => `${fmtNum(num(u.invocationsM) * 1_000_000)} invocations`,
  },
  {
    key: 'dynamodb',
    name: 'DynamoDB',
    fields: [
      { key: 'writesM', label: 'Writes (millions)', kind: 'num', step: 0.1 },
      { key: 'readsM', label: 'Reads (millions)', kind: 'num', step: 0.1 },
      { key: 'storageGb', label: 'Storage (GB)', kind: 'num', step: 0.1 },
    ],
    // On-demand: $1.25 / M write request units, $0.25 / M read request units,
    // $0.25 / GB-month. The first 25 GB are free.
    price: u =>
      num(u.writesM) * 1.25
      + num(u.readsM) * 0.25
      + Math.max(0, num(u.storageGb) - 25) * 0.25,
    summary: u => `${num(u.writesM)}M writes · ${num(u.readsM)}M reads`,
  },
  {
    key: 'sns',
    name: 'SNS',
    fields: [
      { key: 'publishesM', label: 'Publishes (millions)', kind: 'num', step: 0.1 },
    ],
    // First 1M publishes free, then $0.50 per million.
    price: u => Math.max(0, num(u.publishesM) - 1) * 0.50,
    summary: u => `${num(u.publishesM)}M publishes`,
  },
  {
    key: 'sqs',
    name: 'SQS',
    fields: [
      { key: 'requestsM', label: 'Requests (millions)', kind: 'num', step: 0.1 },
    ],
    // First 1M requests free, then $0.40 per million (standard queue).
    price: u => Math.max(0, num(u.requestsM) - 1) * 0.40,
    summary: u => `${num(u.requestsM)}M requests`,
  },
  {
    key: 'secrets',
    name: 'Secrets Manager',
    fields: [
      { key: 'secrets', label: 'Secrets', kind: 'int', step: 1 },
      { key: 'requestsK', label: 'API requests (×1k)', kind: 'num', step: 1 },
    ],
    price: u =>
      num(u.secrets) * 0.40
      + num(u.requestsK) / 10 * 0.05,
    summary: u => `${num(u.secrets)} secret${num(u.secrets) === 1 ? '' : 's'}`,
  },
  {
    key: 'eventbridge',
    name: 'EventBridge',
    fields: [
      { key: 'customEventsM', label: 'Custom events (millions)', kind: 'num', step: 0.1 },
    ],
    // $1.00 per million custom events.
    price: u => num(u.customEventsM) * 1.0,
    summary: u => `${num(u.customEventsM)}M events`,
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }
function fmtUsd(n) { return `$${n.toFixed(n < 1 ? 4 : 2)}`; }
function fmtNum(n) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }

// Build the default usage object for all services with their declared defaults.
function blankUsage() {
  const out = {};
  for (const s of SERVICES) {
    out[s.key] = {};
    for (const f of s.fields) out[s.key][f.key] = f.default ?? 0;
  }
  return out;
}

// Map MockCloud's /status payload onto the same usage shape. Anything we
// can't measure (S3 PUT/GET counts, Lambda duration/memory, DDB ops) stays
// at the field's declared default — typically 0 — so the projection only
// reflects what we actually observe.
function liveUsageFromStatus(status) {
  const u = blankUsage();
  const s = status?.stats || {};
  u.ec2.instances = s.ec2Running || 0;
  u.s3.storageGb = (s.s3Bytes || 0) / 1024 / 1024 / 1024;
  u.lambda.invocationsM = (s.lambdaInvocations || 0) / 1_000_000;
  u.dynamodb.storageGb = 0; // not tracked
  u.secrets.secrets = s.secrets || 0;
  return u;
}

// ── Page ────────────────────────────────────────────────────────────────────
export function BillingPage({ pushToast }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('live');     // 'live' | 'custom'
  const [customUsage, setCustomUsage] = useState(blankUsage);

  const load = useCallback(async () => {
    setLoading(true);
    try { setStatus(await api.status()); }
    catch (e) { pushToast?.({ kind: 'err', title: 'Could not refresh', body: e.message }); }
    finally { setLoading(false); }
  }, [pushToast]);
  useEffect(() => { load(); }, [load]);

  const liveUsage = useMemo(() => liveUsageFromStatus(status), [status]);
  const usage = mode === 'custom' ? customUsage : liveUsage;

  const breakdown = useMemo(() => SERVICES.map(s => ({
    key: s.key,
    name: s.name,
    summary: s.summary(usage[s.key] || {}),
    cost: s.price(usage[s.key] || {}),
  })), [usage]);
  const total = breakdown.reduce((sum, r) => sum + r.cost, 0);

  function setCustomField(serviceKey, fieldKey, raw) {
    setCustomUsage(prev => ({
      ...prev,
      [serviceKey]: { ...prev[serviceKey], [fieldKey]: raw },
    }));
  }

  // When entering custom mode for the first time after a live load, seed the
  // editor with the current observed usage so users can tweak from reality.
  function enterCustom() {
    setCustomUsage(prev => {
      const seeded = blankUsage();
      for (const s of SERVICES) {
        for (const f of s.fields) {
          const live = liveUsage[s.key]?.[f.key];
          seeded[s.key][f.key] = (live ?? 0) || prev[s.key][f.key] || (f.default ?? 0);
        }
      }
      return seeded;
    });
    setMode('custom');
  }

  return (
    <>
      <Breadcrumb items={['Console Home', 'Billing & Cost']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconBilling size={20} /></div>
            <div>
              <h1 className="page-title">Billing & Cost</h1>
              <p className="page-subtitle">
                {mode === 'live'
                  ? 'MockCloud is free. This page projects what your current resources would cost on real AWS (us-east-1, on-demand).'
                  : 'What-if calculator. Dial in any usage to estimate the real-AWS bill — no resources are created.'}
              </p>
            </div>
          </div>
          <div className="page-actions">
            {mode === 'live' && (
              <Button icon={Icons.IconRefresh} onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</Button>
            )}
            {mode === 'custom' && (
              <Button onClick={() => setCustomUsage(blankUsage())}>Reset</Button>
            )}
            <div className="seg" role="tablist" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              <button
                className="btn"
                aria-pressed={mode === 'live'}
                onClick={() => setMode('live')}
                style={segStyle(mode === 'live')}
              >Live</button>
              <button
                className="btn"
                aria-pressed={mode === 'custom'}
                onClick={enterCustom}
                style={segStyle(mode === 'custom')}
              >What-if</button>
            </div>
          </div>
        </div>

        <div className="stats-row">
          <Stat label="Projected (real AWS)" value={fmtUsd(total)} />
          <Stat label="You pay" value="$0.00" tint="ok" />
          <Stat label="Mode" value={mode === 'live' ? 'Live' : 'What-if'} />
          <Stat label="Resources priced" value={breakdown.filter(r => r.cost > 0).length} />
        </div>

        <Card title={mode === 'live' ? 'Cost breakdown (current resources)' : 'Cost breakdown (custom inputs)'} bodyPad={false}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 160 }}>Service</th>
                <th>{mode === 'live' ? 'Usage' : 'Inputs'}</th>
                <th style={{ width: 160, textAlign: 'right' }}>Real AWS cost</th>
              </tr>
            </thead>
            <tbody>
              {SERVICES.map(s => {
                const row = breakdown.find(b => b.key === s.key);
                return (
                  <tr key={s.key}>
                    <td style={{ fontWeight: 500 }}>{s.name}</td>
                    <td className="mono muted" style={{ fontSize: 12.5 }}>
                      {mode === 'live'
                        ? row.summary
                        : (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            {s.fields.map(f => (
                              <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{f.label}</span>
                                <input
                                  className="input"
                                  type="number"
                                  min="0"
                                  step={f.step}
                                  value={customUsage[s.key]?.[f.key] ?? 0}
                                  onChange={e => setCustomField(s.key, f.key, e.target.value)}
                                  style={{ width: 120, height: 28 }}
                                />
                              </label>
                            ))}
                          </div>
                        )
                      }
                    </td>
                    <td className="mono muted" style={{ textAlign: 'right' }}>{fmtUsd(row.cost)}</td>
                  </tr>
                );
              })}
              <tr style={{ borderTop: '2px solid var(--border)' }}>
                <td colSpan={2} style={{ textAlign: 'right', fontWeight: 600, paddingRight: 16 }}>
                  Projected total (real AWS)
                </td>
                <td className="mono" style={{ textAlign: 'right', fontWeight: 700, fontSize: 15 }}>{fmtUsd(total)}</td>
              </tr>
            </tbody>
          </table>
        </Card>

        <div style={{ marginTop: 16 }}>
          <Card title={mode === 'live' ? 'Savings vs real AWS' : 'About this estimate'}>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.8, color: 'var(--fg-muted)' }}>
              {mode === 'live' ? (
                <>
                  <li>MockCloud is 100% free — you&apos;re saving <strong style={{ color: 'var(--fg)' }}>{fmtUsd(total)}/month</strong> versus running this on real AWS.</li>
                  <li>Live mode only counts what we can observe on this daemon (resource counts, S3 bytes, Lambda invocations, etc.). Per-request charges (S3 PUT/GET, DDB reads/writes, SNS publishes) aren&apos;t tracked here — switch to <em>What-if</em> to model them.</li>
                  <li>EC2 cost assumes t3.small ($0.0208/hr) running 730 hrs/mo; bump the hourly rate in What-if mode for other instance types.</li>
                </>
              ) : (
                <>
                  <li>Estimates use on-demand <strong>us-east-1</strong> pricing and apply each service&apos;s standard free tier.</li>
                  <li>Lambda cost = requests + GB-seconds (duration × memory). Defaults: 100ms, 128MB.</li>
                  <li>DynamoDB uses on-demand pricing ($1.25/M writes, $0.25/M reads, $0.25/GB-month after 25 GB free).</li>
                  <li>Reserved instances, savings plans, and data-transfer charges aren&apos;t modeled.</li>
                </>
              )}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

function segStyle(active) {
  return {
    padding: '6px 12px',
    fontSize: 12.5,
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#fff' : 'var(--fg)',
    border: 'none',
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
  };
}
