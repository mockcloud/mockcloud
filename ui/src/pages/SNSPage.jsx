import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, Empty, Stat, Breadcrumb, RowMenu, SimpleCreateModal, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

export function SNSPage({ pushToast }) {
  const [topics, setTopics] = useState([]);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async()=>{ try { const d=await api.sns.topics(); setTopics(d.topics||[]); } catch(e){ pushToast({kind:'err',title:'SNS error',body:e.message}); } },[]);
  useEffect(()=>{ load(); },[load]);

  return (
    <>
      <Breadcrumb items={['Console Home','SNS','Topics']}/>
      <div className="page">
        <div className="page-header">
          <div className="page-title-row"><div className="service-icon"><Icons.IconSNS size={20}/></div>
            <div><h1 className="page-title">SNS topics</h1><p className="page-subtitle">Publish/subscribe messaging with fan-out to SQS, Lambda, or HTTP.</p></div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate(true)}>Create topic</Button>
          </div>
        </div>
        <div className="stats-row">
          <Stat label="Topics" value={topics.length}/>
          <Stat label="Subscriptions" value={topics.reduce((s,t)=>s+(t.subscriptions?.length||0),0)}/>
          <Stat label="Published today" value={topics.reduce((s,t)=>s+(t.published||0),0).toLocaleString()} tint="ok"/>
        </div>
        <Card title="Topics" count={topics.length} bodyPad={false}>
          {topics.length===0
            ? <Empty icon={Icons.IconSNS} title="No topics" message="Create a topic to start publishing messages." actions={<Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate(true)}>Create topic</Button>}/>
            : <table className="tbl">
                <thead><tr><th>Name</th><th>Subscriptions</th><th>Published</th><th>Created</th><th></th></tr></thead>
                <tbody>{topics.map(t=>(
                  <tr key={t.arn}>
                    <td><div style={{display:'flex',alignItems:'center',gap:10}}><Icons.IconSNS size={14} style={{color:'var(--accent)'}}/><span style={{fontWeight:500}}>{t.name}</span></div></td>
                    <td className="mono">{t.subscriptions?.length||0}</td>
                    <td className="mono">{(t.published||0).toLocaleString()}</td>
                    <td className="mono muted">{relTime(t.created)}</td>
                    <td><RowMenu items={[
                      { label:'Publish message', icon:Icons.IconPlay, onClick:async()=>{ try{ await api.sns.publish(t.name,'{"test":true}'); pushToast({kind:'ok',title:'Published',body:t.name}); load(); }catch(e){pushToast({kind:'err',title:'Error',body:e.message});} }},
                      'divider',
                      { label:'Delete', icon:Icons.IconX, danger:true, onClick:async()=>{ try{ await api.sns.delete(t.arn); pushToast({kind:'ok',title:'Topic deleted',body:t.name}); load(); }catch(e){pushToast({kind:'err',title:'Error',body:e.message});} }},
                    ]}/></td>
                  </tr>
                ))}</tbody>
              </table>
          }
        </Card>
      </div>
      {showCreate && <SimpleCreateModal title="Create topic" label="Topic name" placeholder="order-events" onClose={()=>setShowCreate(false)} onCreate={async name=>{
        try{ await api.sns.create(name); pushToast({kind:'ok',title:'Topic created',body:name}); setShowCreate(false); load(); }catch(e){pushToast({kind:'err',title:'Error',body:e.message});}
      }}/>}
    </>
  );
}

// ─── SQS ────────────────────────────────────────────────────────────────────
