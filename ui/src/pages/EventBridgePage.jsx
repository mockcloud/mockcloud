import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, Empty, Stat, Breadcrumb, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

export function EventBridgePage({ pushToast }) {
  const [buses, setBuses]   = useState([]);
  const [rules, setRules]   = useState([]);
  const [events, setEvents] = useState([]);
  const [selBus, setSelBus] = useState('default');
  const [loading, setLoading] = useState(false);
  const [tab, setTab]       = useState('rules');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [b, r, e] = await Promise.all([
        api.eventbridge.buses(),
        api.eventbridge.rules(selBus),
        api.eventbridge.events(),
      ]);
      setBuses(b.buses || []);
      setRules(r.rules || []);
      setEvents(e.events || []);
    } catch(e) { pushToast({ kind:'err', title:'EventBridge error', body:e.message }); }
    finally { setLoading(false); }
  }, [selBus]);

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const deleteRule = useCallback(async (name) => {
    if (!confirm(`Delete rule "${name}"?`)) return;
    try { await api.eventbridge.deleteRule(selBus, name); pushToast({ kind:'ok', title:'Rule deleted', body:name }); load(); }
    catch(e) { pushToast({ kind:'err', title:'Error', body:e.message }); }
  }, [selBus, load]);

  return (
    <>
      <Breadcrumb items={['Console Home', 'EventBridge', 'Rules']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconSparkles size={20} /></div>
            <div>
              <h1 className="page-title">EventBridge</h1>
              <p className="page-subtitle">Event-driven rules and buses — real cross-service wiring</p>
            </div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
          </div>
        </div>

        <div className="stats-row">
          <Stat label="Event buses"  value={buses.length} />
          <Stat label="Rules"        value={rules.length} />
          <Stat label="Events fired" value={events.length} />
          <Stat label="Active rules" value={rules.filter(r => r.state === 'ENABLED').length} tint="ok" />
        </div>

        <div style={{display:'flex',gap:8,marginBottom:12}}>
          {buses.map(b => (
            <button key={b.name} className={`btn ${selBus === b.name ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setSelBus(b.name)}>
              {b.name} <span className="mono muted" style={{fontSize:11}}>({b.ruleCount})</span>
            </button>
          ))}
        </div>

        <div style={{display:'flex',gap:8,marginBottom:12}}>
          {['rules','events'].map(t => (
            <button key={t} className={`tab ${tab===t?'active':''}`} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase()+t.slice(1)}
            </button>
          ))}
        </div>

        {tab === 'rules' && (
          <Card title="Rules" count={rules.length} bodyPad={false}>
            {rules.length === 0 ? (
              <Empty icon={Icons.IconSparkles} title="No rules" message="Rules are created via AWS SDK or Terraform." />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Name</th><th>State</th><th>Pattern / Schedule</th><th>Targets</th><th></th></tr></thead>
                  <tbody>
                    {rules.map(r => (
                      <tr key={r.name}>
                        <td style={{fontWeight:500}}>{r.name}</td>
                        <td><span style={{color: r.state === 'ENABLED' ? 'var(--ok)' : 'var(--fg-muted)'}}>{r.state}</span></td>
                        <td className="mono muted" style={{fontSize:11,maxWidth:240,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                          {r.scheduleExpression || r.eventPattern || '—'}
                        </td>
                        <td className="mono">{r.targetCount}</td>
                        <td><button className="btn btn-ghost btn-sm" onClick={() => deleteRule(r.name)}>Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {tab === 'events' && (
          <Card title="Recent Events" count={events.length} bodyPad={false}>
            {events.length === 0 ? (
              <Empty icon={Icons.IconSparkles} title="No events yet" message="Events appear here when PutEvents is called." />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Source</th><th>Detail Type</th><th>Bus</th><th>Time</th></tr></thead>
                  <tbody>
                    {events.slice(0, 100).map(e => (
                      <tr key={e.id}>
                        <td className="mono">{e.source}</td>
                        <td>{e.detailType}</td>
                        <td className="mono muted">{e.bus}</td>
                        <td className="mono muted">{relTime(e.time)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
