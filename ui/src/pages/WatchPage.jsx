import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, Stat, Spinner, MiniChart, Breadcrumb } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

function stateKind(s) {
  return { running:'ok', pending:'pending', stopped:'stopped', terminated:'err' }[s] || 'stopped';
}

export function WatchPage() {
  const [dash, setDash]       = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setDash(await api.cloudwatch.dashboard()); }
    catch(e) { console.error('CloudWatch error', e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  const live = dash?.live || {};

  const toPoints = (arr) => (arr || []).map(p => p.v);

  const widgets = dash ? [
    { title: 'Lambda Invocations',   data: toPoints(dash.lambdaInvocations), tint: 'var(--accent)', value: live.lambdaInvocations ?? 0, suffix: 'total' },
    { title: 'Lambda Errors',        data: toPoints(dash.lambdaErrors),      tint: 'var(--err)',    value: live.lambdaErrors ?? 0,      suffix: 'errors' },
    { title: 'S3 Objects',           data: toPoints(dash.s3Objects),         tint: 'var(--info)',   value: live.s3Objects ?? 0,         suffix: 'objects' },
    { title: 'SQS Messages',         data: toPoints(dash.sqsMessages),       tint: 'var(--warn)',   value: live.sqsMessages ?? 0,       suffix: 'in flight' },
    { title: 'DynamoDB Latency (ms)',data: toPoints(dash.dynamoLatency),     tint: 'var(--ok)',     value: dash.dynamoLatency?.slice(-1)[0]?.v?.toFixed(1) ?? '—', suffix: 'ms' },
    { title: 'EC2 Running',          data: toPoints(dash.ec2Running),        tint: 'var(--accent)', value: live.ec2Running ?? 0,        suffix: 'instances' },
  ] : [];

  return (
    <>
      <Breadcrumb items={['Console Home', 'CloudWatch']}/>
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconWatch size={20}/></div>
            <div>
              <h1 className="page-title">CloudWatch</h1>
              <p className="page-subtitle">Real metrics from your MockCloud services. Auto-refreshes every 30s.</p>
            </div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
          </div>
        </div>

        {loading && !dash ? (
          <div style={{display:'flex',justifyContent:'center',padding:40}}><Spinner/></div>
        ) : (
          <>
            <div className="stats-row">
              <Stat label="Lambda functions"  value={live.lambdaFunctions ?? 0}/>
              <Stat label="S3 buckets"        value={live.s3Buckets ?? 0}/>
              <Stat label="DynamoDB tables"   value={live.dynamoTables ?? 0}/>
              <Stat label="EventBridge rules" value={live.ebRules ?? 0}/>
            </div>

            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(280px,1fr))',gap:12,marginTop:12}}>
              {widgets.map((w, i) => (
                <Card key={i} title={w.title} actions={<span className="mono muted" style={{fontSize:11}}>live</span>}>
                  <div style={{fontSize:22,fontWeight:600,letterSpacing:'-0.02em'}}>
                    {typeof w.value === 'number' ? w.value.toLocaleString() : w.value}
                    <span style={{fontSize:12,color:'var(--fg-muted)',fontWeight:400,marginLeft:6}}>{w.suffix}</span>
                  </div>
                  {w.data.length > 1
                    ? <MiniChart data={w.data} tint={w.tint}/>
                    : <div style={{height:40,display:'flex',alignItems:'center',color:'var(--fg-muted)',fontSize:12}}>Collecting data — metrics update every 60s</div>
                  }
                </Card>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
