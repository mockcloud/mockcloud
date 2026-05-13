import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, Empty, Stat, Breadcrumb, Spinner, Modal, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

export function CognitoPage({ pushToast }) {
  const [pools, setPools]         = useState([]);
  const [users, setUsers]         = useState([]);
  const [loading, setLoading]     = useState(false);
  const [sel, setSel]             = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateUser, setShowCreateUser] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.cognito.userPools(); setPools(d.userPools || []); }
    catch(e) { pushToast({ kind:'err', title:'Cognito error', body:e.message }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadUsers = useCallback(async (id) => {
    try { const d = await api.cognito.users(id); setUsers(d.users || []); }
    catch { setUsers([]); }
  }, []);

  const selectPool = (p) => { setSel(p); loadUsers(p.id); };

  const deletePool = async (id, e) => {
    e.stopPropagation();
    if (!confirm('Delete this user pool? All users will be deleted.')) return;
    try { await api.cognito.deletePool(id); pushToast({ kind:'ok', title:'User pool deleted' }); setSel(null); load(); }
    catch(e) { pushToast({ kind:'err', title:'Error', body:e.message }); }
  };

  if (sel) return (
    <>
      <Breadcrumb items={['Console Home', { label:'Cognito', onClick:()=>setSel(null) }, sel.name]} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconIAM size={20} /></div>
            <div><h1 className="page-title">{sel.name}</h1><p className="page-subtitle">{sel.id} · {users.length} users</p></div>
          </div>
          <div className="page-actions">
            <Button onClick={() => setSel(null)}>Back</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowCreateUser(true)}>Create user</Button>
          </div>
        </div>
        <Card title="Users" count={users.length} bodyPad={false}>
          {users.length === 0
            ? <Empty icon={Icons.IconIAM} title="No users" message="Create users to test authentication flows."
                actions={<Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowCreateUser(true)}>Create user</Button>} />
            : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Username</th><th>Email</th><th>Status</th><th>Created</th><th style={{width:80}}></th></tr></thead>
                  <tbody>
                    {users.map(u => {
                      const email = u.Attributes?.find(a => a.Name === 'email')?.Value;
                      return (
                        <tr key={u.Username}>
                          <td style={{fontWeight:500}}>{u.Username}</td>
                          <td className="mono muted">{email || '—'}</td>
                          <td><span style={{color: u.UserStatus==='CONFIRMED'?'var(--ok)':'var(--warn)'}}>{u.UserStatus}</span></td>
                          <td className="mono muted">{relTime(u.UserCreateDate * 1000)}</td>
                          <td>
                            <button className="btn btn-ghost btn-sm" onClick={async () => {
                              if (!confirm(`Delete user "${u.Username}"?`)) return;
                              try { await api.cognito.deleteUser(sel.id, u.Username); pushToast({kind:'ok',title:'User deleted'}); loadUsers(sel.id); }
                              catch(e) { pushToast({kind:'err',title:'Error',body:e.message}); }
                            }}>Remove</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          }
        </Card>
      </div>
      {showCreateUser && <CreateUserModal poolId={sel.id} onClose={() => setShowCreateUser(false)} onCreated={() => { setShowCreateUser(false); loadUsers(sel.id); load(); }} pushToast={pushToast} />}
    </>
  );

  return (
    <>
      <Breadcrumb items={['Console Home', 'Cognito', 'User Pools']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconIAM size={20} /></div>
            <div><h1 className="page-title">Cognito</h1><p className="page-subtitle">User pools and authentication</p></div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowCreate(true)}>Create user pool</Button>
          </div>
        </div>

        <div className="stats-row">
          <Stat label="User pools" value={pools.length} />
          <Stat label="Total users" value={pools.reduce((s,p) => s+p.userCount, 0)} />
        </div>

        <Card title="User Pools" count={pools.length} bodyPad={false}>
          {pools.length === 0
            ? <Empty icon={Icons.IconIAM} title="No user pools" message="Create a user pool to manage authentication."
                actions={<Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowCreate(true)}>Create user pool</Button>} />
            : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Name</th><th>ID</th><th>Users</th><th>Clients</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {pools.map(p => (
                      <tr key={p.id} onClick={() => selectPool(p)} style={{cursor:'pointer'}}>
                        <td style={{fontWeight:500}}>{p.name}</td>
                        <td className="mono muted" style={{fontSize:11}}>{p.id}</td>
                        <td className="mono">{p.userCount}</td>
                        <td className="mono">{p.clientCount}</td>
                        <td><span style={{color:'var(--ok)'}}>{p.status}</span></td>
                        <td><button className="btn btn-ghost btn-sm" onClick={e => deletePool(p.id, e)}>Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Card>
      </div>

      {showCreate && <CreatePoolModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} pushToast={pushToast} />}
    </>
  );
}

function CreatePoolModal({ onClose, onCreated, pushToast }) {
  const [name, setName]     = useState('');
  const [loading, setLoading] = useState(false);
  const create = async () => {
    if (!name) return;
    setLoading(true);
    try { await api.cognito.createPool(name); pushToast({ kind:'ok', title:'User pool created', body:name }); onCreated(); }
    catch(e) { pushToast({ kind:'err', title:'Error', body:e.message }); }
    finally { setLoading(false); }
  };
  return (
    <Modal title="Create user pool" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name||loading} onClick={create}>{loading?'Creating…':'Create'}</Button></>}>
      <div className="field">
        <label className="field-label">Pool name</label>
        <input autoFocus className="input" value={name} onChange={e => setName(e.target.value)} placeholder="my-app-users" style={{height:34}} />
      </div>
    </Modal>
  );
}

function CreateUserModal({ poolId, onClose, onCreated, pushToast }) {
  const [username, setUsername] = useState('');
  const [email, setEmail]       = useState('');
  const [loading, setLoading]   = useState(false);
  const valid = username.trim().length >= 1;
  const create = async () => {
    if (!valid) return;
    setLoading(true);
    try {
      await api.cognito.createUser(poolId, username.trim(), email.trim() || undefined);
      pushToast({ kind: 'ok', title: 'User created', body: username });
      onCreated();
    } catch (e) {
      pushToast({ kind: 'err', title: 'Error', body: e.message });
    } finally {
      setLoading(false);
    }
  };
  return (
    <Modal title="Create user" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid||loading} onClick={create}>{loading?'Creating…':'Create user'}</Button></>}>
      <div className="field">
        <label className="field-label">Username</label>
        <input autoFocus className="input" value={username} onChange={e => setUsername(e.target.value)} placeholder="alice" style={{height:34}} />
        <span className="field-hint">Required. Used as the login identifier.</span>
      </div>
      <div className="field">
        <label className="field-label">Email <span className="muted">(optional)</span></label>
        <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="alice@example.com" style={{height:34}} />
      </div>
    </Modal>
  );
}
