import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, Empty, Status, Breadcrumb, Spinner, Modal, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

export function LambdaPage({ pushToast }) {
  const [functions, setFunctions] = useState([]);
  const [sel, setSel] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try { const d = await api.lambda.functions(); setFunctions(d.functions||[]); }
    catch(e) { pushToast({kind:'err',title:'Lambda error',body:e.message}); }
  }, []);

  const deleteFn = useCallback(async (name, e) => {
    e.stopPropagation();
    if (!confirm(`Delete function "${name}"?`)) return;
    try { await api.lambda.delete(name); pushToast({kind:'ok',title:'Function deleted',body:name}); load(); }
    catch(e) { pushToast({kind:'err',title:'Delete failed',body:e.message}); }
  }, [load]);

  useEffect(() => { load(); }, [load]);

  if (sel) return <LambdaDetail fnName={sel} onBack={()=>{ setSel(null); load(); }} pushToast={pushToast} />;

  return (
    <>
      <Breadcrumb items={['Console Home','Lambda','Functions']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconLambda size={20}/></div>
            <div>
              <h1 className="page-title">Lambda functions</h1>
              <p className="page-subtitle">Invoke serverless functions locally. Cold starts simulated.</p>
            </div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate(true)}>Create function</Button>
          </div>
        </div>
        <Card title="Functions" count={functions.length} bodyPad={false}>
          {functions.length===0
            ? <Empty icon={Icons.IconLambda} title="No functions" message="Create your first Lambda function." actions={<Button variant="primary" icon={Icons.IconPlus} onClick={()=>setShowCreate(true)}>Create function</Button>}/>
            : (
              <table className="tbl">
                <thead><tr><th>Name</th><th>Runtime</th><th>Memory</th><th>Invocations</th><th>Last invoked</th><th>Status</th></tr></thead>
                <tbody>
                  {functions.map(f=>(
                    <tr key={f.name} onClick={()=>setSel(f.name)} style={{cursor:'pointer'}}>
                      <td><div style={{display:'flex',alignItems:'center',gap:10}}><Icons.IconLambda size={14} style={{color:'var(--accent)'}}/><span style={{fontWeight:500}}>{f.name}</span></div></td>
                      <td className="mono muted">{f.runtime}</td>
                      <td className="mono">{f.memory} MB</td>
                      <td className="mono">{(f.invocations||0).toLocaleString()}</td>
                      <td className="mono muted">{relTime(f.lastInvoked)}</td>
                      <td><Status kind={f.errors?'err':'ok'}>{f.errors?`${f.errors} errors`:'healthy'}</Status></td>
                      <td><button className="btn btn-ghost btn-sm" onClick={e=>deleteFn(f.name,e)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </Card>
      </div>
      {showCreate && (
        <CreateFunctionModal onClose={()=>setShowCreate(false)} onCreate={async body=>{
          try { await api.lambda.create(body); pushToast({kind:'ok',title:'Function created',body:body.name}); setShowCreate(false); load(); }
          catch(e) { pushToast({kind:'err',title:'Error',body:e.message}); }
        }} />
      )}
    </>
  );
}

function CreateFunctionModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState('nodejs20.x');
  const [memory, setMemory] = useState(128);
  return (
    <Modal title="Create function" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name} onClick={()=>onCreate({name,runtime,memory:parseInt(memory),handler:'index.handler'})}>Create function</Button></>}>
      <div className="field">
        <label className="field-label">Function name</label>
        <input autoFocus className="input mono" value={name} onChange={e=>setName(e.target.value)} placeholder="my-function" style={{height:34}}/>
      </div>
      <div className="field">
        <label className="field-label">Runtime</label>
        <select className="select" value={runtime} onChange={e=>setRuntime(e.target.value)}>
          <option>nodejs20.x</option><option>nodejs18.x</option><option>python3.12</option><option>python3.11</option><option>go1.x</option>
        </select>
      </div>
      <div className="field">
        <label className="field-label">Memory (MB)</label>
        <select className="select" value={memory} onChange={e=>setMemory(e.target.value)}>
          {[128,256,512,1024,2048,3008].map(m=><option key={m}>{m}</option>)}
        </select>
      </div>
    </Modal>
  );
}

function LambdaDetail({ fnName, onBack, pushToast }) {
  const [fn, setFn] = useState(null);
  const [tab, setTab] = useState('invoke');
  const [payload, setPayload] = useState('{\n  "name": "world"\n}');
  const [output, setOutput] = useState(null);
  const [invoking, setInvoking] = useState(false);

  useEffect(() => { api.lambda.fn(fnName).then(setFn).catch(()=>{}); }, [fnName]);

  const invoke = async () => {
    setInvoking(true); setOutput(null);
    try {
      let p = {}; try { p = JSON.parse(payload); } catch {}
      const r = await api.lambda.invoke(fnName, p);
      setOutput(r);
      setFn(f => f ? {...f, invocations:(f.invocations||0)+1, lastInvoked:Date.now(), logs:r.logs||f.logs} : f);
      pushToast({kind:'ok',title:'Invocation complete',body:`${fnName} · 200 OK`});
    } catch(e) { pushToast({kind:'err',title:'Invocation failed',body:e.message}); }
    finally { setInvoking(false); }
  };

  if (!fn) return <div className="page" style={{padding:40,display:'flex',alignItems:'center',gap:8}}><Spinner/>Loading…</div>;

  return (
    <>
      <Breadcrumb items={[
        'Console Home',
        { label:'Lambda', onClick: onBack },
        { label:'Functions', onClick: onBack },
        fn.name,
      ]} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconLambda size={20}/></div>
            <div>
              <h1 className="page-title">{fn.name}</h1>
              <p className="page-subtitle"><span className="mono">{fn.runtime}</span> · {fn.memory} MB · {(fn.invocations||0).toLocaleString()} invocations</p>
            </div>
          </div>
          <div className="page-actions">
            <Button onClick={onBack}>Back</Button>
            <Button variant="primary" icon={Icons.IconPlay} onClick={invoke} disabled={invoking}>{invoking?'Invoking…':'Test'}</Button>
          </div>
        </div>
        <div className="tabs">
          {['invoke','logs','config'].map(t=><button key={t} className={`tab ${tab===t?'active':''}`} onClick={()=>setTab(t)}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>)}
        </div>
        {tab==='invoke' && (
          <div className="detail-grid">
            <Card title="Event payload">
              <textarea className="input mono" value={payload} onChange={e=>setPayload(e.target.value)}
                style={{width:'100%',minHeight:180,fontSize:12.5,lineHeight:1.55,padding:12,background:'var(--bg-code)',resize:'vertical'}}/>
              <div style={{marginTop:10}}>
                <Button variant="primary" icon={Icons.IconPlay} onClick={invoke} disabled={invoking}>{invoking?<><Spinner size={12}/>Invoking…</>:'Run test'}</Button>
              </div>
            </Card>
            <Card title="Response">
              {!output && !invoking && <div className="muted" style={{fontSize:12.5}}>Response will appear here.</div>}
              {invoking && <div style={{display:'flex',alignItems:'center',gap:8}} className="muted"><Spinner/> Waiting…</div>}
              {output && <>
                <div className="hstack" style={{marginBottom:8}}>
                  <Status kind="ok">200 OK</Status>
                  <span className="mono muted" style={{fontSize:11.5}}>{output.duration}ms</span>
                </div>
                <pre style={{margin:0,padding:12,background:'var(--bg-code)',borderRadius:8,fontSize:12,overflow:'auto'}}>{JSON.stringify(output.response,null,2)}</pre>
              </>}
            </Card>
          </div>
        )}
        {tab==='logs' && (
          <Card title="Execution logs" count={fn.logs?.length||0} bodyPad={false}>
            <div className="logs">
              {(fn.logs||[]).map((l,i)=>(
                <div className="log-line" key={i}>
                  <span className="t">{new Date(l.t).toISOString().substr(11,12)}</span>
                  <span className={`lvl ${l.level||l.lvl}`}>{l.level||l.lvl}</span>
                  <span className="msg">{l.msg}</span>
                </div>
              ))}
              {(!fn.logs||fn.logs.length===0) && <div style={{padding:'20px 14px',color:'var(--fg-subtle)',fontFamily:'var(--font-mono)',fontSize:12}}>// No log entries yet — invoke the function first</div>}
            </div>
          </Card>
        )}
        {tab==='config' && (
          <Card title="Configuration">
            <dl className="kv">
              <dt>ARN</dt><dd className="mono">arn:aws:lambda:us-east-1:000000000000:function:{fn.name}</dd>
              <dt>Runtime</dt><dd className="mono">{fn.runtime}</dd>
              <dt>Memory</dt><dd>{fn.memory} MB</dd>
              <dt>Timeout</dt><dd>{fn.timeout}s</dd>
              <dt>Handler</dt><dd className="mono">{fn.handler}</dd>
              <dt>Environment</dt><dd className="mono">{JSON.stringify(fn.env||{})}</dd>
              <dt>Created</dt><dd className="mono">{fn.created ? new Date(fn.created).toISOString() : '—'}</dd>
            </dl>
          </Card>
        )}
      </div>
    </>
  );
}

// ─── DynamoDB ────────────────────────────────────────────────────────────────
