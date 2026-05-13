import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, Empty, Stat, Breadcrumb, Spinner, Modal } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

export function SSMPage({ pushToast }) {
  const [params, setParams]         = useState([]);
  const [loading, setLoading]       = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch]         = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.ssm.parameters(); setParams(d.parameters || []); }
    catch(e) { pushToast({ kind:'err', title:'SSM error', body:e.message }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const deleteParam = useCallback(async (name, e) => {
    e.stopPropagation();
    if (!confirm(`Delete parameter "${name}"?`)) return;
    try { await api.ssm.delete(name); pushToast({ kind:'ok', title:'Parameter deleted', body:name }); load(); }
    catch(e) { pushToast({ kind:'err', title:'Error', body:e.message }); }
  }, [load]);

  const filtered = params.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      <Breadcrumb items={['Console Home', 'SSM', 'Parameter Store']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconFile size={20} /></div>
            <div>
              <h1 className="page-title">SSM Parameter Store</h1>
              <p className="page-subtitle">Hierarchical configuration and secrets storage</p>
            </div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowCreate(true)}>Add parameter</Button>
          </div>
        </div>

        <div className="stats-row">
          <Stat label="Parameters" value={params.length} />
          <Stat label="String"     value={params.filter(p => p.type === 'String').length} />
          <Stat label="SecureString" value={params.filter(p => p.type === 'SecureString').length} tint="ok" />
        </div>

        <Card title="Parameters" count={filtered.length} bodyPad={false}
          actions={
            <div className="input-search">
              <Icons.IconSearch size={14} />
              <input placeholder="Filter by path…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          }>
          {filtered.length === 0 ? (
            <Empty icon={Icons.IconFile} title="No parameters" message="Store configuration values as SSM parameters."
              actions={<Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowCreate(true)}>Add parameter</Button>} />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Name</th><th>Type</th><th>Value</th><th>Version</th><th></th></tr></thead>
                <tbody>
                  {filtered.map(p => (
                    <tr key={p.name}>
                      <td className="mono" style={{fontWeight:500}}>{p.name}</td>
                      <td><span className="mono muted">{p.type}</span></td>
                      <td className="mono" style={{maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                        {p.type === 'SecureString' ? '••••••••' : p.value}
                      </td>
                      <td className="mono muted">v{p.version}</td>
                      <td><button className="btn btn-ghost btn-sm" onClick={e => deleteParam(p.name, e)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {loading && <div className="muted" style={{padding:'8px 16px',fontSize:12}}><Spinner size={12}/> Loading…</div>}
        </Card>
      </div>

      {showCreate && <CreateParamModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} pushToast={pushToast} />}
    </>
  );
}

function CreateParamModal({ onClose, onCreated, pushToast }) {
  const [name, setName]   = useState('/');
  const [value, setValue] = useState('');
  const [type, setType]   = useState('String');
  const [loading, setLoading] = useState(false);

  const create = async () => {
    if (!name || !value) return;
    setLoading(true);
    try { await api.ssm.create({ name, value, type }); pushToast({ kind:'ok', title:'Parameter created', body:name }); onCreated(); }
    catch(e) { pushToast({ kind:'err', title:'Error', body:e.message }); }
    finally { setLoading(false); }
  };

  return (
    <Modal title="Add parameter" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name||!value||loading} onClick={create}>{loading ? 'Creating…' : 'Add parameter'}</Button></>}>
      <div className="field">
        <label className="field-label">Name (path)</label>
        <input autoFocus className="input" value={name} onChange={e => setName(e.target.value)} placeholder="/myapp/database/host" style={{height:34}} />
        <span className="field-hint">Use / to create a hierarchy e.g. /prod/db/password</span>
      </div>
      <div className="field">
        <label className="field-label">Type</label>
        <select className="select" value={type} onChange={e => setType(e.target.value)} style={{width:'100%'}}>
          <option value="String">String</option>
          <option value="SecureString">SecureString</option>
          <option value="StringList">StringList</option>
        </select>
      </div>
      <div className="field">
        <label className="field-label">Value</label>
        <input className="input" value={value} onChange={e => setValue(e.target.value)} placeholder="parameter value" style={{height:34}} />
      </div>
    </Modal>
  );
}
