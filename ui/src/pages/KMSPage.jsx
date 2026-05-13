import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, Empty, Stat, Breadcrumb, Spinner, Modal } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

export function KMSPage({ pushToast }) {
  const [keys, setKeys]           = useState([]);
  const [loading, setLoading]     = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.kms.keys(); setKeys(d.keys || []); }
    catch(e) { pushToast({ kind:'err', title:'KMS error', body:e.message }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const deleteKey = useCallback(async (id, e) => {
    e.stopPropagation();
    if (!confirm(`Schedule key "${id.slice(0,8)}…" for deletion?`)) return;
    try { await api.kms.delete(id); pushToast({ kind:'ok', title:'Key scheduled for deletion', body:id }); load(); }
    catch(e) { pushToast({ kind:'err', title:'Error', body:e.message }); }
  }, [load]);

  return (
    <>
      <Breadcrumb items={['Console Home', 'KMS', 'Keys']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconSecrets size={20} /></div>
            <div>
              <h1 className="page-title">KMS</h1>
              <p className="page-subtitle">Managed encryption keys for your services</p>
            </div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowCreate(true)}>Create key</Button>
          </div>
        </div>

        <div className="stats-row">
          <Stat label="Total keys"    value={keys.length} />
          <Stat label="Enabled"       value={keys.filter(k => k.state === 'Enabled').length} tint="ok" />
          <Stat label="Pending deletion" value={keys.filter(k => k.state === 'PendingDeletion').length} tint="warn" />
        </div>

        <Card title="Customer Managed Keys" count={keys.length} bodyPad={false}>
          {keys.length === 0 ? (
            <Empty icon={Icons.IconSecrets} title="No keys" message="Create a KMS key to encrypt your data."
              actions={<Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowCreate(true)}>Create key</Button>} />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Key ID</th><th>Description</th><th>Usage</th><th>State</th><th>Created</th><th></th></tr></thead>
                <tbody>
                  {keys.map(k => (
                    <tr key={k.id}>
                      <td className="mono" style={{fontSize:11.5}}>{k.id}</td>
                      <td>{k.description || <span className="muted">—</span>}</td>
                      <td className="mono muted">{k.usage}</td>
                      <td><span style={{color: k.state === 'Enabled' ? 'var(--ok)' : 'var(--warn)'}}>{k.state}</span></td>
                      <td className="mono muted">{k.created ? new Date(k.created * 1000).toLocaleDateString() : '—'}</td>
                      <td><button className="btn btn-ghost btn-sm" onClick={e => deleteKey(k.id, e)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {loading && <div className="muted" style={{padding:'8px 16px',fontSize:12}}><Spinner size={12}/> Loading…</div>}
        </Card>
      </div>

      {showCreate && <CreateKeyModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} pushToast={pushToast} />}
    </>
  );
}

function CreateKeyModal({ onClose, onCreated, pushToast }) {
  const [description, setDescription] = useState('');
  const [usage, setUsage]             = useState('ENCRYPT_DECRYPT');
  const [loading, setLoading]         = useState(false);

  const create = async () => {
    setLoading(true);
    try { await api.kms.create({ description, usage }); pushToast({ kind:'ok', title:'Key created', body:description || 'New key' }); onCreated(); }
    catch(e) { pushToast({ kind:'err', title:'Error', body:e.message }); }
    finally { setLoading(false); }
  };

  return (
    <Modal title="Create KMS key" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={loading} onClick={create}>{loading ? 'Creating…' : 'Create key'}</Button></>}>
      <div className="field">
        <label className="field-label">Description</label>
        <input autoFocus className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. my-app-encryption-key" style={{height:34}} />
      </div>
      <div className="field">
        <label className="field-label">Key usage</label>
        <select className="select" value={usage} onChange={e => setUsage(e.target.value)} style={{width:'100%'}}>
          <option value="ENCRYPT_DECRYPT">Encrypt and Decrypt</option>
          <option value="SIGN_VERIFY">Sign and Verify</option>
        </select>
      </div>
    </Modal>
  );
}
