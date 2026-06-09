import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Card, Empty, Stat, Status, Breadcrumb, Spinner, MiniChart, RowMenu, Modal, SimpleCreateModal, formatBytes, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { TerminalView } from '../components/Terminal.jsx';
import { api } from '../api.js';

function stateKind(s) {
  return { running:'ok', pending:'pending', stopped:'stopped', terminated:'err' }[s] || 'stopped';
}

export function IAMPage({ pushToast }) {
  const [tab, setTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [showCreate, setShowCreate] = useState(null);

  const load = useCallback(async()=>{
    try { const [u,r]=await Promise.all([api.iam.users(),api.iam.roles()]); setUsers(u.users||[]); setRoles(r.roles||[]); }
    catch(e){ pushToast({kind:'err',title:'IAM error',body:e.message}); }
  },[]);
  useEffect(()=>{ load(); const id=setInterval(load,3000); return ()=>clearInterval(id); },[load]);

  return (
    <>
      <Breadcrumb items={['Console Home','IAM']}/>
      <div className="page">
        <div className="page-header">
          <div className="page-title-row"><div className="service-icon"><Icons.IconIAM size={20}/></div>
            <div><h1 className="page-title">IAM</h1><p className="page-subtitle">Users, roles, and policies — full semantic match with real IAM.</p></div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate(tab==='users'?'user':'role')}>{tab==='users'?'Add user':'Create role'}</Button>
          </div>
        </div>
        <div className="stats-row">
          <Stat label="Users" value={users.length}/>
          <Stat label="Roles" value={roles.length}/>
          <Stat label="MFA enabled" value={`${users.filter(u=>u.mfa).length}/${users.length}`} tint="ok"/>
        </div>
        <div className="tabs">
          {['users','roles','policies'].map(t=><button key={t} className={`tab ${tab===t?'active':''}`} onClick={()=>setTab(t)}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>)}
        </div>
        {tab==='users' && <Card title="Users" count={users.length} bodyPad={false}>
          {users.length===0
            ? <Empty icon={Icons.IconIAM} title="No users" message="Add an IAM user to get started." actions={<Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate('user')}>Add user</Button>}/>
            : <table className="tbl"><thead><tr><th>Name</th><th>Groups</th><th>MFA</th><th>Created</th><th></th></tr></thead>
              <tbody>{users.map(u=>(
                <tr key={u.name}>
                  <td><div style={{display:'flex',alignItems:'center',gap:10}}>
                    <div style={{width:24,height:24,borderRadius:'50%',background:'var(--bg-muted)',display:'grid',placeItems:'center',fontSize:11,fontWeight:600}}>{u.name.slice(0,2).toUpperCase()}</div>
                    <span className="mono">{u.name}</span>
                  </div></td>
                  <td>{(u.groups||[]).map(g=><span key={g} className="nav-tag" style={{marginRight:4}}>{g}</span>)}</td>
                  <td>{u.mfa ? <Status kind="ok">enabled</Status> : <Status kind="err">disabled</Status>}</td>
                  <td className="mono muted">{relTime(u.created)}</td>
                  <td><RowMenu items={[
                    { label:'Delete user', icon:Icons.IconX, danger:true, onClick:async()=>{ try{ await api.iam.deleteUser(u.name); pushToast({kind:'ok',title:'User deleted',body:u.name}); load(); }catch(e){pushToast({kind:'err',title:'Error',body:e.message});} }},
                  ]}/></td>
                </tr>
              ))}</tbody>
            </table>
          }
        </Card>}
        {tab==='roles' && <Card title="Roles" count={roles.length} bodyPad={false}>
          {roles.length===0
            ? <Empty icon={Icons.IconIAM} title="No roles" message="Create a role to allow services to access resources." actions={<Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate('role')}>Create role</Button>}/>
            : <table className="tbl"><thead><tr><th>Name</th><th>Policies</th><th>Created</th><th></th></tr></thead>
              <tbody>{roles.map(r=>(
                <tr key={r.name}>
                  <td><div style={{display:'flex',alignItems:'center',gap:10}}><Icons.IconIAM size={14} style={{color:'var(--accent)'}}/><span className="mono">{r.name}</span></div></td>
                  <td className="mono muted">{(r.policies||[]).length} policies</td>
                  <td className="mono muted">{relTime(r.created)}</td>
                  <td><RowMenu items={[
                    { label:'Delete role', icon:Icons.IconX, danger:true, onClick:async()=>{ try{ await api.iam.deleteRole(r.name); pushToast({kind:'ok',title:'Role deleted',body:r.name}); load(); }catch(e){pushToast({kind:'err',title:'Error',body:e.message});} }},
                  ]}/></td>
                </tr>
              ))}</tbody>
            </table>
          }
        </Card>}
        {tab==='policies' && <Card title="Managed policies"><pre style={{margin:0,fontSize:12}}>{`[\n  "AdministratorAccess",\n  "AmazonS3FullAccess",\n  "AmazonDynamoDBFullAccess",\n  "AWSLambdaExecute",\n  "IAMReadOnlyAccess"\n]`}</pre></Card>}
      </div>
      {showCreate && <CreateIAMModal kind={showCreate} onClose={()=>setShowCreate(null)} onCreate={async body=>{
        try{
          if(showCreate==='user') { await api.iam.createUser(body); pushToast({kind:'ok',title:'User created',body:body.name}); }
          else { await api.iam.createRole(body); pushToast({kind:'ok',title:'Role created',body:body.name}); }
          setShowCreate(null); load();
        }catch(e){pushToast({kind:'err',title:'Error',body:e.message});}
      }}/>}
    </>
  );
}

function CreateIAMModal({ kind, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [policies, setPolicies] = useState(new Set());
  const all = ['AdministratorAccess','AmazonS3FullAccess','AmazonDynamoDBFullAccess','AWSLambdaExecute','IAMReadOnlyAccess'];
  return (
    <Modal title={kind==='user'?'Add user':'Create role'} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name} onClick={()=>onCreate({name,policies:[...policies]})}>{kind==='user'?'Add user':'Create role'}</Button></>}>
      <div className="field"><label className="field-label">{kind==='user'?'User name':'Role name'}</label>
        <input autoFocus className="input mono" value={name} onChange={e=>setName(e.target.value)} placeholder={kind==='user'?'developer':'LambdaExecution'} style={{height:34}}/>
      </div>
      <div className="field"><label className="field-label">Attach policies</label>
        <div style={{display:'flex',flexDirection:'column',gap:4}}>
          {all.map(p=>(
            <label key={p} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',border:'1px solid var(--border)',borderRadius:6,cursor:'pointer',background:policies.has(p)?'var(--accent-soft)':'var(--bg-input)'}}>
              <input type="checkbox" className="cb" checked={policies.has(p)} onChange={e=>{const s=new Set(policies);e.target.checked?s.add(p):s.delete(p);setPolicies(s);}}/>
              <span className="mono" style={{fontSize:12.5}}>{p}</span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ─── Localwatch ──────────────────────────────────────────────────────────────
