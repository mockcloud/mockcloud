import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Card, Empty, Stat, Status, Breadcrumb, Spinner, MiniChart, Modal, formatBytes, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

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
  const [showCreateItem, setShowCreateItem] = useState(false);
  const [showCreateIndex, setShowCreateIndex] = useState(false);

  const load = useCallback(() => {
    api.dynamo.table(tableName).then(setTable).catch(()=>{});
  }, [tableName]);

  useEffect(() => { load(); }, [load]);

  const createItem = useCallback(async (item) => {
    try { await api.dynamo.putItem(tableName, item); pushToast({kind:'ok',title:'Item saved',body:String(item[table.pk])}); setShowCreateItem(false); load(); }
    catch(e) { pushToast({kind:'err',title:'Save failed',body:e.message}); }
  }, [tableName, table, load]);

  const deleteItem = useCallback(async (pkVal) => {
    if (!confirm(`Delete item "${pkVal}"?`)) return;
    try { await api.dynamo.deleteItem(tableName, pkVal); pushToast({kind:'ok',title:'Item deleted',body:String(pkVal)}); load(); }
    catch(e) { pushToast({kind:'err',title:'Delete failed',body:e.message}); }
  }, [tableName, load]);

  const createIndex = useCallback(async (body) => {
    try { await api.dynamo.createIndex(tableName, body); pushToast({kind:'ok',title:'Index created',body:body.name}); setShowCreateIndex(false); load(); }
    catch(e) { pushToast({kind:'err',title:'Error',body:e.message}); }
  }, [tableName, load]);

  const deleteIndex = useCallback(async (name) => {
    if (!confirm(`Delete index "${name}"?`)) return;
    try { await api.dynamo.deleteIndex(tableName, name); pushToast({kind:'ok',title:'Index deleted',body:name}); load(); }
    catch(e) { pushToast({kind:'err',title:'Delete failed',body:e.message}); }
  }, [tableName, load]);

  if (!table) return <div className="page" style={{padding:40,display:'flex',alignItems:'center',gap:8}}><Spinner/>Loading…</div>;
  const cols = table.items.length ? Object.keys(table.items[0]) : [table.pk, ...(table.sk?[table.sk]:[])];
  const indexes = table.indexes || [];

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
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreateItem(true)}>Create item</Button>
          </div>
        </div>
        <div className="tabs">
          {['items','query','schema','indexes','metrics'].map(t=><button key={t} className={`tab ${tab===t?'active':''}`} onClick={()=>setTab(t)}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>)}
        </div>
        {tab==='items' && (
          table.items.length===0
            ? <Empty icon={Icons.IconDB} title="No items" message="Add an item to this table to get started." actions={<Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreateItem(true)}>Create item</Button>}/>
            : <Card title="Items" count={table.items.length} bodyPad={false}
                actions={<Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreateItem(true)}>Create item</Button>}>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead><tr>{cols.map(c=><th key={c}>{c}{c===table.pk?' (PK)':c===table.sk?' (SK)':''}</th>)}<th></th></tr></thead>
                    <tbody>
                      {table.items.map((it,i)=>(
                        <tr key={i}>
                          {cols.map(c=><td key={c} className="mono" style={{maxWidth:200,overflow:'hidden',textOverflow:'ellipsis'}}>{fmtVal(it[c])}</td>)}
                          <td style={{textAlign:'right'}}><button className="btn btn-ghost btn-sm" onClick={()=>deleteItem(it[table.pk])}>Remove</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
        )}
        {tab==='query' && <QueryRunner table={table} pushToast={pushToast} />}
        {tab==='schema' && <Card title="Schema"><dl className="kv">
          <dt>Partition key</dt><dd className="mono">{table.pk} (String)</dd>
          {table.sk && <><dt>Sort key</dt><dd className="mono">{table.sk} (String)</dd></>}
          <dt>Billing mode</dt><dd>{table.billingMode}</dd>
          <dt>Item count</dt><dd className="mono">{table.itemCount}</dd>
          <dt>Storage</dt><dd className="mono">{formatBytes(table.sizeBytes||0)}</dd>
          <dt>Secondary indexes</dt><dd className="mono">{indexes.length}</dd>
        </dl></Card>}
        {tab==='indexes' && (
          indexes.length===0
            ? <Empty icon={Icons.IconDB} title="No secondary indexes" message="Create a GSI or LSI to query by alternate keys." actions={<Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreateIndex(true)}>Create index</Button>}/>
            : <Card title="Secondary indexes" count={indexes.length} bodyPad={false}
                actions={<Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreateIndex(true)}>Create index</Button>}>
                <table className="tbl">
                  <thead><tr><th>Name</th><th>Type</th><th>Partition key</th><th>Sort key</th><th>Projection</th><th></th></tr></thead>
                  <tbody>
                    {indexes.map(ix=>(
                      <tr key={ix.name}>
                        <td><span style={{fontWeight:500}}>{ix.name}</span></td>
                        <td>{ix.type}</td>
                        <td className="mono">{ix.pk}</td>
                        <td className="mono muted">{ix.sk||'—'}</td>
                        <td>{ix.projection}{ix.projection==='INCLUDE'&&ix.nonKeyAttributes?.length?` (${ix.nonKeyAttributes.join(', ')})`:''}</td>
                        <td style={{textAlign:'right'}}><button className="btn btn-ghost btn-sm" onClick={()=>deleteIndex(ix.name)}>Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
        )}
        {tab==='metrics' && <MetricsTab tableName={tableName} active={tab==='metrics'} />}
      </div>
      {showCreateItem && <CreateItemModal table={table} onClose={()=>setShowCreateItem(false)} onCreate={createItem}/>}
      {showCreateIndex && <CreateIndexModal table={table} onClose={()=>setShowCreateIndex(false)} onCreate={createIndex}/>}
    </>
  );
}

// Render a stored attribute value compactly for the items table.
function fmtVal(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function CreateItemModal({ table, onClose, onCreate }) {
  const seed = useMemo(() => {
    const o = { [table.pk]: '' };
    if (table.sk) o[table.sk] = '';
    return JSON.stringify(o, null, 2);
  }, [table]);
  const [text, setText] = useState(seed);
  const [error, setError] = useState(null);

  const submit = () => {
    let obj;
    try { obj = JSON.parse(text); }
    catch (e) { setError('Invalid JSON: ' + e.message); return; }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) { setError('Item must be a JSON object'); return; }
    if (obj[table.pk] === undefined || obj[table.pk] === '') { setError(`Partition key "${table.pk}" is required`); return; }
    if (table.sk && (obj[table.sk] === undefined || obj[table.sk] === '')) { setError(`Sort key "${table.sk}" is required`); return; }
    onCreate(obj);
  };

  return (
    <Modal title="Create item" onClose={onClose} wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save item</Button></>}>
      <div className="field">
        <label className="field-label">Item (JSON)</label>
        <textarea className="input mono" value={text} onChange={e=>{setText(e.target.value); setError(null);}}
          spellCheck={false} style={{minHeight:200, width:'100%', resize:'vertical', lineHeight:1.5, padding:10}}/>
        <span className="field-hint">Must include partition key <span className="mono">{table.pk}</span>{table.sk?<> and sort key <span className="mono">{table.sk}</span></>:null}. Values may be strings, numbers, booleans, arrays, or nested objects.</span>
        {error && <span className="field-hint" style={{color:'var(--err)'}}>{error}</span>}
      </div>
    </Modal>
  );
}

function CreateIndexModal({ table, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('GSI');
  const [pk, setPk] = useState('');
  const [sk, setSk] = useState('');
  const [projection, setProjection] = useState('ALL');
  const [nonKey, setNonKey] = useState('');
  const valid = /^[a-zA-Z0-9_.-]{3,64}$/.test(name) && pk.trim().length > 0
    && (projection !== 'INCLUDE' || nonKey.trim().length > 0);
  const submit = () => onCreate({
    name, type, pk: pk.trim(), sk: sk.trim() || undefined, projection,
    nonKeyAttributes: projection === 'INCLUDE'
      ? nonKey.split(',').map(a => a.trim()).filter(Boolean)
      : undefined,
  });
  return (
    <Modal title="Create secondary index" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} onClick={submit}>Create index</Button></>}>
      <div className="field"><label className="field-label">Index name</label>
        <input autoFocus className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="by-status" style={{height:34}}/>
        <span className="field-hint">Letters, digits, dashes, dots, underscores. 3–64 chars.</span>
      </div>
      <div className="field"><label className="field-label">Index type</label>
        <select className="select" value={type} onChange={e=>setType(e.target.value)} style={{height:34}}>
          <option value="GSI">Global secondary index (GSI)</option>
          <option value="LSI">Local secondary index (LSI)</option>
        </select>
      </div>
      <div className="field"><label className="field-label">Partition key</label>
        <input className="input mono" value={pk} onChange={e=>setPk(e.target.value)} placeholder="status" style={{height:34}}/>
      </div>
      <div className="field"><label className="field-label">Sort key (optional)</label>
        <input className="input mono" value={sk} onChange={e=>setSk(e.target.value)} placeholder="created_at" style={{height:34}}/>
      </div>
      <div className="field"><label className="field-label">Projection</label>
        <select className="select" value={projection} onChange={e=>setProjection(e.target.value)} style={{height:34}}>
          <option value="ALL">All attributes</option>
          <option value="KEYS_ONLY">Keys only</option>
          <option value="INCLUDE">Include</option>
        </select>
      </div>
      {projection==='INCLUDE' && <div className="field"><label className="field-label">Projected non-key attributes</label>
        <input className="input mono" value={nonKey} onChange={e=>setNonKey(e.target.value)} placeholder="customer, total" style={{height:34}}/>
        <span className="field-hint">Comma-separated. These (plus the table + index keys) are the only attributes returned when querying this index.</span>
      </div>}
    </Modal>
  );
}

// Lightweight Query runner — runs a real Query against the table or one of its
// secondary indexes via /dynamodb/tables/:name/query, using the same engine the
// AWS API uses. Attribute values are entered as plain JSON.
function QueryRunner({ table, pushToast }) {
  const indexes = table.indexes || [];
  const [indexName, setIndexName] = useState('');
  const [keyExpr, setKeyExpr] = useState('');
  const [filterExpr, setFilterExpr] = useState('');
  const [valuesText, setValuesText] = useState('{\n  ":v": ""\n}');
  const [namesText, setNamesText] = useState('');
  const [limit, setLimit] = useState('');
  const [forward, setForward] = useState(true);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);

  // Default the key-condition placeholder to the active index's keys.
  const activeKeys = indexName
    ? (indexes.find(i => i.name === indexName) || { pk: table.pk, sk: table.sk })
    : { pk: table.pk, sk: table.sk };

  const run = async () => {
    setError(null);
    let values = {}, names;
    if (valuesText.trim()) {
      try { values = JSON.parse(valuesText); }
      catch (e) { setError('Attribute values: invalid JSON — ' + e.message); return; }
    }
    if (namesText.trim()) {
      try { names = JSON.parse(namesText); }
      catch (e) { setError('Attribute names: invalid JSON — ' + e.message); return; }
    }
    setRunning(true);
    try {
      const body = {
        indexName: indexName || undefined,
        keyConditionExpression: keyExpr.trim() || undefined,
        filterExpression: filterExpr.trim() || undefined,
        expressionAttributeValues: values,
        expressionAttributeNames: names,
        limit: limit ? Number(limit) : undefined,
        scanIndexForward: forward,
      };
      const r = await api.dynamo.query(table.name, body);
      setResult(r);
    } catch (e) {
      setError(e.message);
      setResult(null);
    } finally { setRunning(false); }
  };

  const cols = result && result.items.length
    ? Array.from(new Set(result.items.flatMap(i => Object.keys(i))))
    : [];

  return (
    <div className="detail-grid" style={{gridTemplateColumns:'1fr', gap:16}}>
      <Card title="Query">
        <div className="field"><label className="field-label">Index</label>
          <select className="select" value={indexName} onChange={e=>setIndexName(e.target.value)} style={{height:34}}>
            <option value="">Table (primary key: {table.pk}{table.sk?`, ${table.sk}`:''})</option>
            {indexes.map(ix=><option key={ix.name} value={ix.name}>{ix.name} ({ix.type}: {ix.pk}{ix.sk?`, ${ix.sk}`:''})</option>)}
          </select>
        </div>
        <div className="field"><label className="field-label">Key condition expression</label>
          <input className="input mono" value={keyExpr} onChange={e=>setKeyExpr(e.target.value)}
            placeholder={`${activeKeys.pk} = :v${activeKeys.sk?` AND begins_with(${activeKeys.sk}, :s)`:''}`} style={{height:34}}/>
          <span className="field-hint">Leave empty to return all items (scan). Partition key must use <span className="mono">=</span>.</span>
        </div>
        <div className="field"><label className="field-label">Filter expression (optional)</label>
          <input className="input mono" value={filterExpr} onChange={e=>setFilterExpr(e.target.value)} placeholder="amount > :min" style={{height:34}}/>
        </div>
        <div className="field"><label className="field-label">Attribute values (JSON)</label>
          <textarea className="input mono" value={valuesText} onChange={e=>setValuesText(e.target.value)}
            spellCheck={false} style={{minHeight:90, width:'100%', resize:'vertical', lineHeight:1.5, padding:10}}/>
          <span className="field-hint">Plain JSON, e.g. <span className="mono">{'{ ":v": "user#1" }'}</span>.</span>
        </div>
        <div className="field"><label className="field-label">Attribute names (JSON, optional)</label>
          <input className="input mono" value={namesText} onChange={e=>setNamesText(e.target.value)} placeholder='{ "#s": "status" }' style={{height:34}}/>
        </div>
        <div style={{display:'flex', gap:16, alignItems:'center', flexWrap:'wrap'}}>
          <div className="field" style={{margin:0}}><label className="field-label">Limit</label>
            <input className="input mono" value={limit} onChange={e=>setLimit(e.target.value.replace(/[^0-9]/g,''))} placeholder="50" style={{height:34, width:100}}/>
          </div>
          <label className="field-label" style={{display:'flex', alignItems:'center', gap:8, cursor:'pointer', marginTop:18}}>
            <input type="checkbox" className="cb" checked={forward} onChange={e=>setForward(e.target.checked)}/> Sort ascending
          </label>
          <Button variant="primary" onClick={run} disabled={running} style={{marginTop:18}}>{running?'Running…':'Run query'}</Button>
        </div>
        {error && <span className="field-hint" style={{color:'var(--err)'}}>{error}</span>}
      </Card>

      {result && <Card title="Results" count={result.count}
        actions={<span className="muted mono" style={{fontSize:12}}>Scanned {result.scannedCount}{result.lastEvaluatedKey?' · more available':''}</span>} bodyPad={false}>
        {result.items.length===0
          ? <Empty icon={Icons.IconDB} title="No matches" message="No items matched this query."/>
          : <div className="tbl-wrap"><table className="tbl">
              <thead><tr>{cols.map(c=><th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {result.items.map((it,i)=>(
                  <tr key={i}>{cols.map(c=><td key={c} className="mono" style={{maxWidth:240,overflow:'hidden',textOverflow:'ellipsis'}}>{fmtVal(it[c])}</td>)}</tr>
                ))}
              </tbody>
            </table></div>
        }
      </Card>}
    </div>
  );
}

function MetricsTab({ tableName, active }) {
  const [m, setM] = useState(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    api.dynamo.metrics(tableName).then(d => { if (alive) setM(d); }).catch(()=>{});
    return () => { alive = false; };
  }, [tableName, active]);

  if (!m) return <div className="page" style={{padding:24,display:'flex',alignItems:'center',gap:8}}><Spinner/>Loading metrics…</div>;

  const series = s => (s || []).map(p => p.v);
  const reads = series(m.readCapacity), writes = series(m.writeCapacity), lat = series(m.latency);
  const hasActivity = m.reads > 0 || m.writes > 0;

  return (
    <>
      <div className="stats-row">
        <Stat label="Read ops" value={m.reads}/>
        <Stat label="Write ops" value={m.writes}/>
        <Stat label="Consumed RCU" value={m.consumedRead}/>
        <Stat label="Consumed WCU" value={m.consumedWrite}/>
        <Stat label="Avg latency" value={m.avgLatency} suffix="ms"/>
      </div>
      {!hasActivity
        ? <Empty icon={Icons.IconWatch} title="No activity recorded yet"
            message="Run reads or writes against this table (via the SDK, CLI, or the Items tab) and capacity metrics will appear here."/>
        : <div className="detail-grid">
            <Card title="Consumed read capacity">
              {reads.length >= 2 ? <MiniChart data={reads}/> : <p className="muted" style={{padding:'8px 4px'}}>Collecting… {reads.length} sample{reads.length===1?'':'s'} so far.</p>}
            </Card>
            <Card title="Consumed write capacity">
              {writes.length >= 2 ? <MiniChart data={writes} tint="var(--info)"/> : <p className="muted" style={{padding:'8px 4px'}}>Collecting… {writes.length} sample{writes.length===1?'':'s'} so far.</p>}
            </Card>
            <Card title="Request latency (ms)">
              {lat.length >= 2 ? <MiniChart data={lat} tint="var(--warn)"/> : <p className="muted" style={{padding:'8px 4px'}}>Collecting… {lat.length} sample{lat.length===1?'':'s'} so far.</p>}
            </Card>
          </div>
      }
    </>
  );
}

// ─── SNS ────────────────────────────────────────────────────────────────────
