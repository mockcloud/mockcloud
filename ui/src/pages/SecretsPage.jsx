import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, Empty, Status, Breadcrumb, RowMenu, Modal, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

export function SecretsPage({ pushToast }) {
  const [secrets, setSecrets] = useState([]);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async()=>{ try { const d=await api.secrets.list(); setSecrets(d.secrets||[]); } catch(e){ pushToast({kind:'err',title:'Secrets error',body:e.message}); } },[]);
  useEffect(()=>{ load(); },[load]);

  return (
    <>
      <Breadcrumb items={['Console Home','Secrets Manager']}/>
      <div className="page">
        <div className="page-header">
          <div className="page-title-row"><div className="service-icon"><Icons.IconSecrets size={20}/></div>
            <div><h1 className="page-title">Secrets Manager</h1><p className="page-subtitle">Securely store API keys, DB credentials, and tokens. Encrypted at rest.</p></div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate(true)}>Store secret</Button>
          </div>
        </div>
        <Card title="Secrets" count={secrets.length} bodyPad={false}>
          {secrets.length===0
            ? <Empty icon={Icons.IconSecrets} title="No secrets" message="Store your first secret to get started." actions={<Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate(true)}>Store secret</Button>}/>
            : <table className="tbl">
                <thead><tr><th>Name</th><th>Last updated</th><th>Rotation</th><th>Status</th><th></th></tr></thead>
                <tbody>{secrets.map(s=>(
                  <tr key={s.name}>
                    <td><div style={{display:'flex',alignItems:'center',gap:10}}><Icons.IconSecrets size={14} style={{color:'var(--accent)'}}/><span className="mono">{s.name}</span></div></td>
                    <td className="mono muted">{relTime(s.updated)}</td>
                    <td className="mono">{s.rotation}</td>
                    <td><Status kind="ok">encrypted</Status></td>
                    <td><RowMenu items={[
                      // List endpoint omits the value — fetch it; toast body stays the name so the value never hits the screen
                      { label:'Copy value', icon:Icons.IconCopy, onClick:async()=>{ try{ if(!navigator.clipboard) throw new Error('Clipboard requires a secure context (https or localhost)'); const d=await api.secrets.get(s.name); await navigator.clipboard.writeText(d.value); pushToast({kind:'ok',title:'Copied',body:s.name}); }catch(e){ pushToast({kind:'err',title:'Copy failed',body:e.message}); } }},
                      'divider',
                      { label:'Delete', icon:Icons.IconX, danger:true, onClick:async()=>{ try{ await api.secrets.delete(s.name); pushToast({kind:'ok',title:'Secret deleted',body:s.name}); load(); }catch(e){pushToast({kind:'err',title:'Error',body:e.message});} }},
                    ]}/></td>
                  </tr>
                ))}</tbody>
              </table>
          }
        </Card>
      </div>
      {showCreate && <StoreSecretModal onClose={()=>setShowCreate(false)} onCreate={async body=>{
        try{ await api.secrets.create(body); pushToast({kind:'ok',title:'Secret stored',body:body.name}); setShowCreate(false); load(); }catch(e){pushToast({kind:'err',title:'Error',body:e.message});}
      }}/>}
    </>
  );
}

function StoreSecretModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [rotation, setRotation] = useState('never');
  return (
    <Modal title="Store a new secret" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name||!value} onClick={()=>onCreate({name,value,rotation})}>Store secret</Button></>}>
      <div className="field"><label className="field-label">Name</label>
        <input autoFocus className="input mono" value={name} onChange={e=>setName(e.target.value)} placeholder="service/api-key" style={{height:34}}/>
        <span className="field-hint">Use slashes to namespace secrets.</span>
      </div>
      <div className="field"><label className="field-label">Value</label>
        <textarea className="input mono" value={value} onChange={e=>setValue(e.target.value)} style={{minHeight:100,padding:10}} placeholder="plaintext or JSON"/>
      </div>
      <div className="field"><label className="field-label">Rotation</label>
        <select className="select" value={rotation} onChange={e=>setRotation(e.target.value)}>
          <option value="never">No automatic rotation</option><option>30 days</option><option>60 days</option><option>90 days</option>
        </select>
      </div>
    </Modal>
  );
}

// ─── IAM ────────────────────────────────────────────────────────────────────
