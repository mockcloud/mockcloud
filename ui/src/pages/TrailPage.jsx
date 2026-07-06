import React, { useState, useMemo } from 'react';
import { Button, Card, Empty, Stat, Status, Breadcrumb, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';

export function TrailPage({ events, onClear }) {
  const [q, setQ] = useState('');
  const [method, setMethod] = useState('all');
  const [status, setStatus] = useState('all');

  const filtered = useMemo(()=>events.filter(e=>{
    if(method!=='all' && e.method!==method) return false;
    if(status==='ok' && e.status>=400) return false;
    if(status==='err' && e.status<400) return false;
    if(q && !`${e.method} ${e.path}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }),[events,q,method,status]);

  const byService = useMemo(()=>{
    const m={};
    events.forEach(e=>{ const svc=(e.path.split('/')[1]||'root').toUpperCase(); m[svc]=(m[svc]||0)+1; });
    return Object.entries(m).sort((a,b)=>b[1]-a[1]);
  },[events]);

  return (
    <>
      <Breadcrumb items={['Console Home','CloudTrail']}/>
      <div className="page">
        <div className="page-header">
          <div className="page-title-row"><div className="service-icon"><Icons.IconTrail size={20}/></div>
            <div><h1 className="page-title">CloudTrail</h1><p className="page-subtitle">Every API call to the local daemon, searchable and exportable.</p></div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconX} onClick={onClear} disabled={events.length===0}>Clear</Button>
            <Button icon={Icons.IconDownload} disabled={filtered.length===0} onClick={()=>{
              // Client-side export of the currently filtered events — no server round-trip
              const blob = new Blob([JSON.stringify(filtered, null, 2)], { type:'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = 'mockcloud-trail.json';
              document.body.appendChild(a); a.click(); a.remove();
              URL.revokeObjectURL(url);
            }}>Export as JSON</Button>
          </div>
        </div>
        <div className="stats-row">
          <Stat label="Events captured" value={events.length.toLocaleString()} tint="ok"/>
          <Stat label="Errors (4xx/5xx)" value={events.filter(e=>e.status>=400).length}/>
          <Stat label="Last event" value={events[0]?relTime(events[0].t):'—'}/>
          <Stat label="Retention" value="7" suffix="days"/>
        </div>
        <div className="detail-grid">
          <Card title="Events" count={filtered.length} bodyPad={false}
            actions={<>
              <div className="input-search" style={{minWidth:220}}><Icons.IconSearch size={14}/><input placeholder="Search path or method…" value={q} onChange={e=>setQ(e.target.value)}/></div>
              <select className="select" value={method} onChange={e=>setMethod(e.target.value)}><option value="all">All methods</option><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option></select>
              <select className="select" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All status</option><option value="ok">2xx/3xx</option><option value="err">4xx/5xx</option></select>
            </>}>
            {filtered.length===0
              ? <Empty icon={Icons.IconTrail} title="No matching events" message="Clear filters or perform an action."/>
              : <div style={{maxHeight:560,overflowY:'auto'}}>
                  <table className="tbl">
                    <thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>Latency</th></tr></thead>
                    <tbody>{filtered.map((e,i)=>(
                      <tr key={i}>
                        <td className="mono muted" style={{width:170}}>{new Date(e.t).toISOString().replace('T',' ').slice(0,19)}</td>
                        <td><span className={`t-method ${e.method}`} style={{fontFamily:'var(--font-mono)',fontSize:11.5,fontWeight:600}}>{e.method}</span></td>
                        <td className="mono">{e.path}</td>
                        <td>{e.status<400 ? <Status kind="ok">{e.status}</Status> : <Status kind="err">{e.status}</Status>}</td>
                        <td className="mono muted">{e.latency}ms</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
            }
          </Card>
          <div>
            <Card title="By service">
              {byService.length===0 ? <div className="muted" style={{fontSize:12.5}}>No events yet.</div> :
                byService.map(([svc,n])=>{ const max=byService[0][1]; return (
                  <div key={svc} style={{marginBottom:10}}>
                    <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:4}}>
                      <span className="mono">{svc.toLowerCase()}</span>
                      <span className="mono muted">{n}</span>
                    </div>
                    <div style={{height:6,background:'var(--bg-muted)',borderRadius:3,overflow:'hidden'}}>
                      <div style={{height:'100%',width:`${(n/max)*100}%`,background:'var(--accent)'}}/>
                    </div>
                  </div>
                );})
              }
            </Card>
            <div style={{height:12}}/>
            <Card title="Status breakdown">
              <dl className="kv">
                <dt>2xx success</dt><dd className="mono">{events.filter(e=>e.status>=200&&e.status<300).length}</dd>
                <dt>3xx redirect</dt><dd className="mono">{events.filter(e=>e.status>=300&&e.status<400).length}</dd>
                <dt>4xx client</dt><dd className="mono">{events.filter(e=>e.status>=400&&e.status<500).length}</dd>
                <dt>5xx server</dt><dd className="mono">{events.filter(e=>e.status>=500).length}</dd>
              </dl>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
