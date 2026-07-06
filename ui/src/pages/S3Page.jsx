import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, Empty, Status, Breadcrumb, Modal, formatBytes, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

export function S3Page({ pushToast }) {
  const [buckets, setBuckets] = useState([]);
  const [sel, setSel] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    try { const d = await api.s3.buckets(); setBuckets(d.buckets||[]); }
    catch(e) { pushToast({kind:'err',title:'S3 error',body:e.message}); }
  }, []);

  const deleteBucket = useCallback(async (name, e) => {
    e.stopPropagation();
    if (!confirm(`Delete bucket "${name}"? This cannot be undone.`)) return;
    try { await api.s3.delete(name); pushToast({kind:'ok',title:'Bucket deleted',body:name}); load(); }
    catch(e) { pushToast({kind:'err',title:'Delete failed',body:e.message}); }
  }, [load]);

  useEffect(() => { load(); }, [load]);

  if (sel) return <S3Detail bucket={sel} onBack={()=>{ setSel(null); load(); }} pushToast={pushToast} />;

  return (
    <>
      <Breadcrumb items={['Console Home','S3','Buckets']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconS3 size={20}/></div>
            <div>
              <h1 className="page-title">S3</h1>
              <p className="page-subtitle">Object storage — buckets persist at <span className="mono">~/.mockcloud/s3</span></p>
            </div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate(true)}>Create bucket</Button>
          </div>
        </div>
        <Card title="Buckets" count={buckets.length} bodyPad={false}>
          {buckets.length === 0
            ? <Empty icon={Icons.IconS3} title="No buckets" message="Create a bucket to start storing objects."
                actions={<Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate(true)}>Create bucket</Button>} />
            : (
              <table className="tbl">
                <thead><tr><th>Name</th><th>Objects</th><th>Size</th><th>Region</th><th>Created</th><th style={{width:40}}></th></tr></thead>
                <tbody>
                  {buckets.map(b => (
                    <tr key={b.name} onClick={()=>setSel(b)} style={{cursor:'pointer'}}>
                      <td><div style={{display:'flex',alignItems:'center',gap:10}}><Icons.IconFolder size={16} style={{color:'var(--accent)'}}/><span style={{fontWeight:500}}>{b.name}</span></div></td>
                      <td className="mono">{b.objectCount}</td>
                      <td className="mono">{formatBytes(b.totalSize)}</td>
                      <td className="mono muted">{b.region}</td>
                      <td className="mono muted">{relTime(b.created)}</td>
                      <td><button className="btn btn-ghost btn-sm" onClick={e=>deleteBucket(b.name,e)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </Card>
      </div>
      {showCreate && (
        <CreateBucketModal onClose={()=>setShowCreate(false)} onCreate={async name=>{
          try { await api.s3.create(name); pushToast({kind:'ok',title:'Bucket created',body:name}); setShowCreate(false); load(); }
          catch(e) { pushToast({kind:'err',title:'Error',body:e.message}); }
        }} />
      )}
    </>
  );
}

function CreateBucketModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const valid = /^[a-z0-9][a-z0-9-]{2,62}$/.test(name);
  return (
    <Modal title="Create bucket" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} onClick={()=>onCreate(name)}>Create bucket</Button></>}>
      <div className="field">
        <label className="field-label">Bucket name</label>
        <input autoFocus className="input" value={name} onChange={e=>setName(e.target.value.toLowerCase())} placeholder="my-app-assets" style={{height:34}} />
        <span className="field-hint">Lowercase letters, digits, and hyphens. 3–63 characters.</span>
      </div>
      <div className="field">
        <label className="field-label">Region</label>
        <select className="select" value={region} onChange={e=>setRegion(e.target.value)}>
          <option>us-east-1</option>
          <option>us-west-2</option>
          <option>eu-west-1</option>
          <option>ap-south-1</option>
          <option>ap-southeast-1</option>
        </select>
      </div>
    </Modal>
  );
}

function S3Detail({ bucket, onBack, pushToast }) {
  const [tab, setTab] = useState('objects');
  const [objects, setObjects] = useState([]);
  const [q, setQ] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = React.useRef(null);

  const refresh = useCallback(() => {
    api.s3.objects(bucket.name).then(d=>setObjects(d.objects||[])).catch(()=>{});
  }, [bucket.name]);

  useEffect(() => { refresh(); }, [refresh]);

  const onFilesPicked = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploading(true);
    let ok = 0, fail = 0;
    for (const f of files) {
      try {
        await api.s3.upload(bucket.name, f.name, f);
        ok++;
      } catch (err) {
        fail++;
        pushToast({ kind: 'err', title: `Upload failed: ${f.name}`, body: err.message });
      }
    }
    setUploading(false);
    e.target.value = '';   // allow re-picking the same file
    if (ok)   pushToast({ kind: 'ok',  title: `Uploaded ${ok} ${ok === 1 ? 'object' : 'objects'}`, body: `to ${bucket.name}` });
    refresh();
  }, [bucket.name, refresh, pushToast]);

  const onDownload = useCallback((key) => {
    // Trigger browser download via the GET endpoint (BASE-aware: prod serves the UI on :4567, API on :4566)
    const url = api.s3.download(bucket.name, key);
    const a = document.createElement('a');
    a.href = url;
    a.download = key.split('/').pop();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [bucket.name]);

  const onDelete = useCallback(async (key) => {
    if (!confirm(`Delete object "${key}"?`)) return;
    try {
      await api.s3.deleteObject(bucket.name, key);
      pushToast({ kind: 'ok', title: 'Object deleted', body: key });
      refresh();
    } catch (e) {
      pushToast({ kind: 'err', title: 'Delete failed', body: e.message });
    }
  }, [bucket.name, refresh, pushToast]);

  const filtered = objects.filter(o=>!q||o.key.startsWith(q));

  return (
    <>
      <Breadcrumb items={[
        'Console Home',
        { label:'S3', onClick: onBack },
        { label:'Buckets', onClick: onBack },
        bucket.name,
      ]} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconFolder size={20}/></div>
            <div>
              <h1 className="page-title">{bucket.name}</h1>
              <p className="page-subtitle"><span className="mono">s3://{bucket.name}</span> · {objects.length} objects · {formatBytes(objects.reduce((s,o)=>s+o.size,0))}</p>
            </div>
          </div>
          <div className="page-actions">
            <Button onClick={onBack}>Back</Button>
            <input ref={fileInputRef} type="file" multiple style={{display:'none'}} onChange={onFilesPicked} />
            <Button variant="primary" icon={Icons.IconUpload}
              disabled={uploading}
              onClick={()=>fileInputRef.current?.click()}>
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        </div>
        <div className="tabs">
          {['objects','properties','permissions','events'].map(t=>(
            <button key={t} className={`tab ${tab===t?'active':''}`} onClick={()=>setTab(t)}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>
          ))}
        </div>
        {tab==='objects' && (
          <Card title="Objects" count={filtered.length} bodyPad={false}
            actions={<div className="input-search"><Icons.IconSearch size={14}/><input placeholder="Search by prefix…" value={q} onChange={e=>setQ(e.target.value)}/></div>}>
            {filtered.length===0
              ? <Empty icon={Icons.IconFile} title="Bucket is empty" message="Upload objects to get started."
                  actions={<Button variant="primary" icon={Icons.IconUpload} onClick={()=>fileInputRef.current?.click()}>Upload</Button>} />
              : filtered.map((o,i)=>(
                <div key={i} className="obj-row">
                  <div className="name"><Icons.IconFile size={14} style={{color:'var(--fg-muted)'}}/><span className="mono">{o.key}</span></div>
                  <span className="size">{formatBytes(o.size)}</span>
                  <span className="modified">{relTime(o.modified)}</span>
                  <button className="btn btn-ghost btn-icon btn-sm" title="Download" onClick={()=>onDownload(o.key)}><Icons.IconDownload size={13}/></button>
                  <button className="btn btn-ghost btn-sm" title="Delete" onClick={()=>onDelete(o.key)}>Remove</button>
                </div>
              ))
            }
          </Card>
        )}
        {tab==='properties' && (
          <Card title="Properties">
            <dl className="kv">
              <dt>ARN</dt><dd className="mono">arn:aws:s3:::{bucket.name}</dd>
              <dt>Region</dt><dd className="mono">{bucket.region}</dd>
              <dt>Versioning</dt><dd><Status kind="stopped">Disabled</Status></dd>
              <dt>Encryption</dt><dd><Status kind="ok">AES-256 (sim)</Status></dd>
              <dt>Created</dt><dd className="mono">{new Date(bucket.created).toISOString()}</dd>
            </dl>
          </Card>
        )}
        {tab==='permissions' && (
          <Card title="Bucket policy">
            <pre style={{margin:0,fontSize:12}}>{`{\n  "Version": "2012-10-17",\n  "Statement": [\n    { "Effect": "Allow", "Principal": "*",\n      "Action": "s3:GetObject",\n      "Resource": "arn:aws:s3:::${bucket.name}/*" }\n  ]\n}`}</pre>
          </Card>
        )}
        {tab==='events' && <Empty icon={Icons.IconSNS} title="No event notifications" message="Send events to SNS, SQS, or Lambda on object changes."/>}
      </div>
    </>
  );
}

// ─── Lambda ─────────────────────────────────────────────────────────────────
