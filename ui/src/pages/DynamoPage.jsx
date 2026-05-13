import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Card, Empty, Stat, Status, Breadcrumb, Spinner, MiniChart, RowMenu, Modal, SimpleCreateModal, formatBytes, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { TerminalView } from '../components/Terminal.jsx';
import { api } from '../api.js';

function stateKind(s) {
  return { running:'ok', pending:'pending', stopped:'stopped', terminated:'err' }[s] || 'stopped';
}

export function DynamoPage({ pushToast }) {
  const [tables, setTables] = useState([]);
  const [sel, setSel] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try { const d = await api.dynamo.tables(); setTables(d.tables||[]); }
    catch(e) { pushToast({kind:'err',title:'DynamoDB error',body:e.message}); }
  }, []);

  const deleteTable = useCallback(async (name, e) => {
    e.stopPropagation();
    if (!confirm(`Delete table "${name}"? All items will be lost.`)) return;
    try { await api.dynamo.delete(name); pushToast({kind:'ok',title:'Table deleted',body:name}); load(); }
    catch(e) { pushToast({kind:'err',title:'Delete failed',body:e.message}); }
  }, [load]);

  useEffect(()=>{ load(); },[load]);

  if (sel) return <DynamoDetail tableName={sel} onBack={()=>{ setSel(null); load(); }} pushToast={pushToast} />;

  return (
    <>
      <Breadcrumb items={['Console Home','DynamoDB','Tables']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconDB size={20}/></div>
            <div>
              <h1 className="page-title">DynamoDB tables</h1>
              <p className="page-subtitle">Local NoSQL, key-value + document, stored as JSON.</p>
            </div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate(true)}>Create table</Button>
          </div>
        </div>
        <div className="stats-row">
          <Stat label="Tables" value={tables.length}/>
          <Stat label="Items" value={tables.reduce((s,t)=>s+t.itemCount,0)}/>
          <Stat label="Storage" value={formatBytes(tables.reduce((s,t)=>s+(t.sizeBytes||0),0))}/>
        </div>
        <Card title="Tables" count={tables.length} bodyPad={false}>
          {tables.length===0
            ? <Empty icon={Icons.IconDB} title="No tables" message="Create a DynamoDB table to get started." actions={<Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate(true)}>Create table</Button>}/>
            : <table className="tbl">
                <thead><tr><th>Name</th><th>Primary key</th><th>Items</th><th>Created</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {tables.map(t=>(
                    <tr key={t.name} onClick={()=>setSel(t.name)} style={{cursor:'pointer'}}>
                      <td><div style={{display:'flex',alignItems:'center',gap:10}}><Icons.IconDB size={14} style={{color:'var(--accent)'}}/><span style={{fontWeight:500}}>{t.name}</span></div></td>
                      <td className="mono">{t.pk}{t.sk?`, ${t.sk}`:''}</td>
                      <td className="mono">{t.itemCount}</td>
                      <td className="mono muted">{relTime(t.created)}</td>
                      <td><Status kind="ok">active</Status></td>
                      <td><button className="btn btn-ghost btn-sm" onClick={e=>deleteTable(t.name,e)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
          }
        </Card>
      </div>
      {showCreate && <CreateTableModal onClose={()=>setShowCreate(false)} onCreate={async body=>{
        try { await api.dynamo.create(body); pushToast({kind:'ok',title:'Table created',body:body.name}); setShowCreate(false); load(); }
        catch(e) { pushToast({kind:'err',title:'Error',body:e.message}); }
      }}/>}
    </>
  );
}

function CreateTableModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [pk, setPk] = useState('id');
  const [sk, setSk] = useState('');
  const [useSk, setUseSk] = useState(false);
  const valid = /^[a-zA-Z0-9_.-]{3,64}$/.test(name);
  return (
    <Modal title="Create table" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} onClick={()=>onCreate({name,pk,sk:useSk?sk:undefined})}>Create table</Button></>}>
      <div className="field"><label className="field-label">Table name</label>
        <input autoFocus className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="orders-v2" style={{height:34}}/>
        <span className="field-hint">Letters, digits, dashes, dots, underscores. 3–64 chars.</span>
      </div>
      <div className="field"><label className="field-label">Partition key</label>
        <input className="input mono" value={pk} onChange={e=>setPk(e.target.value)} placeholder="id" style={{height:34}}/>
      </div>
      <div className="field">
        <label className="field-label" style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer'}}>
          <input type="checkbox" className="cb" checked={useSk} onChange={e=>setUseSk(e.target.checked)}/>Add sort key
        </label>
        {useSk && <input className="input mono" value={sk} onChange={e=>setSk(e.target.value)} placeholder="created_at" style={{marginTop:6,height:34}}/>}
      </div>
    </Modal>
  );
}

function DynamoDetail({ tableName, onBack, pushToast }) {
  const [table, setTable] = useState(null);
  const [tab, setTab] = useState('items');

  useEffect(() => { api.dynamo.table(tableName).then(setTable).catch(()=>{}); }, [tableName]);

  if (!table) return <div className="page" style={{padding:40,display:'flex',alignItems:'center',gap:8}}><Spinner/>Loading…</div>;
  const cols = table.items.length ? Object.keys(table.items[0]) : [table.pk];

  return (
    <>
      <Breadcrumb items={[
        'Console Home',
        { label:'DynamoDB', onClick: onBack },
        { label:'Tables', onClick: onBack },
        table.name,
      ]} />      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconDB size={20}/></div>
            <div>
              <h1 className="page-title">{table.name}</h1>
              <p className="page-subtitle">Primary key: <span className="mono">{table.pk}{table.sk?`, ${table.sk}`:''}</span> · {table.items.length} items</p>
            </div>
          </div>
          <div className="page-actions">
            <Button onClick={onBack}>Back</Button>
            <Button icon={Icons.IconDownload}>Export</Button>
            <Button variant="primary" icon={Icons.IconPlus}>Create item</Button>
          </div>
        </div>
        <div className="tabs">
          {['items','schema','indexes','metrics'].map(t=><button key={t} className={`tab ${tab===t?'active':''}`} onClick={()=>setTab(t)}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>)}
        </div>
        {tab==='items' && (
          <Card title="Items" count={table.items.length} bodyPad={false}
            actions={<><div className="input-search"><Icons.IconSearch size={14}/><input placeholder={`Query by ${table.pk}…`}/></div><select className="select"><option>Scan</option><option>Query</option></select></>}>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr>{cols.map(c=><th key={c}>{c}</th>)}<th></th></tr></thead>
                <tbody>
                  {table.items.map((it,i)=>(
                    <tr key={i}>
                      {cols.map(c=><td key={c} className="mono" style={{maxWidth:200,overflow:'hidden',textOverflow:'ellipsis'}}>{String(it[c]??'')}</td>)}
                      <td></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
        {tab==='schema' && <Card title="Schema"><dl className="kv">
          <dt>Partition key</dt><dd className="mono">{table.pk} (String)</dd>
          {table.sk && <><dt>Sort key</dt><dd className="mono">{table.sk} (String)</dd></>}
          <dt>Billing mode</dt><dd>{table.billingMode}</dd>
          <dt>Item count</dt><dd className="mono">{table.itemCount}</dd>
          <dt>Storage</dt><dd className="mono">{formatBytes(table.sizeBytes||0)}</dd>
        </dl></Card>}
        {tab==='indexes' && <Empty icon={Icons.IconDB} title="No secondary indexes" message="Create a GSI or LSI to query by alternate keys." actions={<Button variant="primary" icon={Icons.IconPlus}>Create index</Button>}/>}
        {tab==='metrics' && <div className="detail-grid">
          <Card title="Read capacity (last hour)"><MiniChart data={[12,14,22,18,30,28,42,38,44,40,34,30]}/></Card>
          <Card title="Write capacity"><MiniChart data={[4,6,8,12,10,14,18,20,16,14,12,10]} tint="var(--info)"/></Card>
        </div>}
      </div>
    </>
  );
}

// ─── SNS ────────────────────────────────────────────────────────────────────
