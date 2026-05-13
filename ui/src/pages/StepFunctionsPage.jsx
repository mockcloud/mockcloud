import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, Empty, Stat, Breadcrumb, Spinner, Status, Modal, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

const DEFAULT_DEFINITION = JSON.stringify({
  Comment: 'A simple two-state workflow',
  StartAt: 'Greet',
  States: {
    Greet: {
      Type: 'Pass',
      Result: { greeting: 'hello' },
      Next: 'Done',
    },
    Done: { Type: 'Succeed' },
  },
}, null, 2);

export function StepFunctionsPage({ pushToast }) {
  const [machines, setMachines] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [sel, setSel]           = useState(null);
  const [executions, setExecutions] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showStart, setShowStart]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.sfn.stateMachines(); setMachines(d.stateMachines || []); }
    catch(e) { pushToast({ kind:'err', title:'Step Functions error', body:e.message }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadExecutions = useCallback(async (name) => {
    try { const d = await api.sfn.executions(name); setExecutions(d.executions || []); }
    catch { setExecutions([]); }
  }, []);

  const selectMachine = (m) => { setSel(m); loadExecutions(m.name); };

  const deleteMachine = async (name, e) => {
    e.stopPropagation();
    if (!confirm(`Delete state machine "${name}"?`)) return;
    try { await api.sfn.delete(name); pushToast({ kind:'ok', title:'State machine deleted', body:name }); setSel(null); load(); }
    catch(e) { pushToast({ kind:'err', title:'Error', body:e.message }); }
  };

  const stateKind = s => ({ SUCCEEDED:'ok', RUNNING:'pending', FAILED:'err', ABORTED:'stopped' }[s] || 'stopped');

  if (sel) return (
    <>
      <Breadcrumb items={['Console Home', { label:'Step Functions', onClick:()=>setSel(null) }, sel.name]} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconSparkles size={20} /></div>
            <div><h1 className="page-title">{sel.name}</h1><p className="page-subtitle">{sel.type} · {sel.status} · {executions.length} execution{executions.length===1?'':'s'}</p></div>
          </div>
          <div className="page-actions">
            <Button onClick={() => setSel(null)}>Back</Button>
            <Button icon={Icons.IconRefresh} onClick={() => loadExecutions(sel.name)}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlay} onClick={() => setShowStart(true)}>Start execution</Button>
          </div>
        </div>
        <Card title="Executions" count={executions.length} bodyPad={false}>
          {executions.length === 0
            ? <Empty icon={Icons.IconSparkles} title="No executions yet" message="Start an execution to see it appear here."
                actions={<Button variant="primary" icon={Icons.IconPlay} onClick={() => setShowStart(true)}>Start execution</Button>} />
            : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Name</th><th>Status</th><th>Started</th><th>Duration</th><th>Output</th></tr></thead>
                  <tbody>
                    {executions.map(e => (
                      <tr key={e.arn || e.name}>
                        <td className="mono" style={{fontSize:12}}>{e.name}</td>
                        <td><Status kind={stateKind(e.status)}>{e.status}</Status></td>
                        <td className="mono muted">{relTime(e.startDate * 1000)}</td>
                        <td className="mono muted">{e.stopDate ? `${((e.stopDate - e.startDate)*1000).toFixed(0)}ms` : '—'}</td>
                        <td className="mono muted" style={{fontSize:11, maxWidth:300, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                          {e.output || (e.status === 'RUNNING' ? '⋯' : '—')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Card>
      </div>
      {showStart && <StartExecutionModal smName={sel.name} onClose={() => setShowStart(false)} onStarted={() => { setShowStart(false); loadExecutions(sel.name); load(); }} pushToast={pushToast} />}
    </>
  );

  return (
    <>
      <Breadcrumb items={['Console Home', 'Step Functions']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconSparkles size={20} /></div>
            <div><h1 className="page-title">Step Functions</h1><p className="page-subtitle">Serverless workflow orchestration</p></div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowCreate(true)}>Create state machine</Button>
          </div>
        </div>

        <div className="stats-row">
          <Stat label="State machines" value={machines.length} />
          <Stat label="Total executions" value={machines.reduce((s,m) => s+m.execCount,0)} />
          <Stat label="Running" value={machines.reduce((s,m) => s+m.runningCount,0)} tint="ok" />
        </div>

        <Card title="State Machines" count={machines.length} bodyPad={false}>
          {machines.length === 0
            ? <Empty icon={Icons.IconSparkles} title="No state machines" message="Create a state machine to orchestrate workflows."
                actions={<Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowCreate(true)}>Create state machine</Button>} />
            : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Executions</th><th>Running</th><th>Created</th><th></th></tr></thead>
                  <tbody>
                    {machines.map(m => (
                      <tr key={m.arn} onClick={() => selectMachine(m)} style={{cursor:'pointer'}}>
                        <td style={{fontWeight:500}}>{m.name}</td>
                        <td className="mono muted">{m.type}</td>
                        <td><span style={{color:'var(--ok)'}}>{m.status}</span></td>
                        <td className="mono">{m.execCount}</td>
                        <td className="mono">{m.runningCount}</td>
                        <td className="mono muted">{relTime(m.created)}</td>
                        <td><button className="btn btn-ghost btn-sm" onClick={e => deleteMachine(m.name, e)}>Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Card>
      </div>
      {showCreate && <CreateStateMachineModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} pushToast={pushToast} />}
    </>
  );
}

function CreateStateMachineModal({ onClose, onCreated, pushToast }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('STANDARD');
  const [definition, setDefinition] = useState(DEFAULT_DEFINITION);
  const [loading, setLoading] = useState(false);

  const validJson = (() => { try { JSON.parse(definition); return true; } catch { return false; } })();
  const valid = name.trim().length >= 1 && validJson;

  const create = async () => {
    if (!valid) return;
    setLoading(true);
    try {
      await api.sfn.create({ name: name.trim(), type, definition });
      pushToast({ kind: 'ok', title: 'State machine created', body: name });
      onCreated();
    } catch (e) {
      pushToast({ kind: 'err', title: 'Error', body: e.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Create state machine" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid||loading} onClick={create}>{loading?'Creating…':'Create'}</Button></>}>
      <div className="field">
        <label className="field-label">Name</label>
        <input autoFocus className="input" value={name} onChange={e => setName(e.target.value)} placeholder="my-workflow" style={{height:34}} />
      </div>
      <div className="field">
        <label className="field-label">Type</label>
        <select className="select" value={type} onChange={e => setType(e.target.value)}>
          <option value="STANDARD">Standard</option>
          <option value="EXPRESS">Express</option>
        </select>
      </div>
      <div className="field">
        <label className="field-label">Definition (Amazon States Language) {!validJson && <span style={{color:'var(--err)'}}>· invalid JSON</span>}</label>
        <textarea className="input" value={definition} onChange={e => setDefinition(e.target.value)} rows={12} style={{fontFamily:'var(--font-mono)', fontSize:11}} />
      </div>
    </Modal>
  );
}

function StartExecutionModal({ smName, onClose, onStarted, pushToast }) {
  const [execName, setExecName] = useState('');
  const [input, setInput] = useState('{\n  "key": "value"\n}');
  const [loading, setLoading] = useState(false);

  const validJson = (() => { try { JSON.parse(input); return true; } catch { return false; } })();

  const start = async () => {
    if (!validJson) return;
    setLoading(true);
    try {
      const r = await api.sfn.startExecution(smName, execName.trim() || undefined, JSON.parse(input));
      pushToast({ kind: 'ok', title: 'Execution started', body: r.name });
      onStarted();
    } catch (e) {
      pushToast({ kind: 'err', title: 'Error', body: e.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={`Start execution — ${smName}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!validJson||loading} onClick={start}>{loading?'Starting…':'Start'}</Button></>}>
      <div className="field">
        <label className="field-label">Execution name <span className="muted">(optional)</span></label>
        <input autoFocus className="input" value={execName} onChange={e => setExecName(e.target.value)} placeholder="auto-generated if blank" style={{height:34}} />
      </div>
      <div className="field">
        <label className="field-label">Input JSON {!validJson && <span style={{color:'var(--err)'}}>· invalid JSON</span>}</label>
        <textarea className="input" value={input} onChange={e => setInput(e.target.value)} rows={8} style={{fontFamily:'var(--font-mono)', fontSize:12}} />
      </div>
    </Modal>
  );
}
