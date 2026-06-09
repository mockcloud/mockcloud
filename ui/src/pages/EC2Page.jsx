import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Card, Empty, Stat, Status, Breadcrumb, Spinner, MiniChart, RowMenu, Modal, SimpleCreateModal, formatBytes, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { TerminalView } from '../components/Terminal.jsx';
import { api } from '../api.js';

const AMIS = [
  { id: 'ami-ubuntu-22', os: 'Ubuntu 22.04 LTS', arch: 'arm64/amd64', size: '8 GiB' },
  { id: 'ami-debian-12', os: 'Debian 12 (Bookworm)', arch: 'amd64', size: '6 GiB' },
  { id: 'ami-alpine-3', os: 'Alpine Linux 3.19', arch: 'amd64', size: '2 GiB' },
  { id: 'ami-nixos-23', os: 'NixOS 23.11', arch: 'amd64', size: '10 GiB' },
];
const TYPES = [
  { id: 't3.nano', cpu: '1 vCPU', mem: '0.5 GiB' },
  { id: 't3.micro', cpu: '2 vCPU', mem: '1 GiB' },
  { id: 't3.small', cpu: '2 vCPU', mem: '2 GiB' },
  { id: 't3.medium', cpu: '2 vCPU', mem: '4 GiB' },
  { id: 'm6i.large', cpu: '2 vCPU', mem: '8 GiB' },
  { id: 'c6i.xlarge', cpu: '4 vCPU', mem: '8 GiB' },
];

function stateKind(s) {
  return { running: 'ok', pending: 'pending', stopped: 'stopped', terminated: 'err' }[s] || 'stopped';
}

export function EC2Page({ pushToast, setCurrent, setTerminalTarget }) {
  const [instances, setInstances] = useState([]);
  const [q, setQ] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [showLaunch, setShowLaunch] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.ec2.instances(); setInstances(d.instances || []); }
    catch (e) { pushToast({ kind: 'err', title: 'EC2 error', body: e.message }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const filtered = instances.filter(x => {
    if (stateFilter !== 'all' && x.state !== stateFilter) return false;
    if (q && !`${x.id} ${x.name} ${x.type}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const onAction = async (id, action) => {
    try {
      await api.ec2.action(id, action);
      pushToast({ kind: 'ok', title: `${action} sent`, body: id });
      setTimeout(load, 500);
    } catch (e) { pushToast({ kind: 'err', title: 'Error', body: e.message }); }
  };

  const onLaunch = async (cfg) => {
    try {
      await api.ec2.launch(cfg);
      pushToast({ kind: 'ok', title: 'Instance launching', body: cfg.name });
      setShowLaunch(false);
      setTimeout(load, 500);
    } catch (e) { pushToast({ kind: 'err', title: 'Launch failed', body: e.message }); }
  };

  return (
    <>
      <Breadcrumb items={['Console Home', 'EC2', 'Instances']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconEC2 size={20} /></div>
            <div>
              <h1 className="page-title">Local EC2</h1>
              <p className="page-subtitle">Emulated virtual servers running on your machine</p>
            </div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowLaunch(true)}>Launch instance</Button>
          </div>
        </div>

        <div className="stats-row">
          <Stat label="Running" value={instances.filter(i => i.state === 'running').length} tint="ok" />
          <Stat label="Stopped" value={instances.filter(i => i.state === 'stopped').length} />
          <Stat label="Pending" value={instances.filter(i => i.state === 'pending').length} tint="warn" />
          <Stat label="vCPU allocated" value={instances.filter(i => i.state === 'running').reduce((s, i) => s + (i.vcpu || 0), 0)} suffix="cores" />
          <Stat label="Memory allocated" value={instances.filter(i => i.state === 'running').reduce((s, i) => s + (i.mem || 0), 0).toFixed(1)} suffix="GiB" />
        </div>

        <Card title="Instances" count={filtered.length} bodyPad={false}
          actions={<>
            <div className="input-search">
              <Icons.IconSearch size={14} />
              <input placeholder="Filter by id, name, type…" value={q} onChange={e => setQ(e.target.value)} />
            </div>
            <select className="select" value={stateFilter} onChange={e => setStateFilter(e.target.value)}>
              <option value="all">All states</option>
              <option value="running">Running</option>
              <option value="stopped">Stopped</option>
              <option value="pending">Pending</option>
            </select>
          </>}
        >
          {filtered.length === 0 ? (
            <Empty icon={Icons.IconEC2}
              title={instances.length === 0 ? 'No instances yet' : 'No matching instances'}
              message={instances.length === 0 ? 'Launch your first virtual server to get started.' : 'Try a different filter.'}
              actions={instances.length === 0 && <Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowLaunch(true)}>Launch instance</Button>}
            />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr>
                  <th style={{ width: 32 }}>
                    <input type="checkbox" className="cb"
                      checked={selected.size === filtered.length && filtered.length > 0}
                      onChange={e => setSelected(e.target.checked ? new Set(filtered.map(i => i.id)) : new Set())}
                    />
                  </th>
                  <th>Instance</th><th>State</th><th>Type</th><th>AMI</th><th>Private IP</th><th>Public IP</th><th>Launched</th><th style={{ width: 56 }}></th>
                </tr></thead>
                <tbody>
                  {filtered.map(row => (
                    <tr key={row.id} className={selected.has(row.id) ? 'selected' : ''}>
                      <td>
                        <input type="checkbox" className="cb" checked={selected.has(row.id)}
                          onChange={e => { const s = new Set(selected); e.target.checked ? s.add(row.id) : s.delete(row.id); setSelected(s); }}
                        />
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontWeight: 500 }}>{row.name}</span>
                          <span className="mono muted" style={{ fontSize: 11.5 }}>{row.id}</span>
                        </div>
                      </td>
                      <td><Status kind={stateKind(row.state)}>{row.state}</Status></td>
                      <td className="mono">{row.type}</td>
                      <td className="mono muted">{row.ami}</td>
                      <td className="mono">{row.privateIp}</td>
                      <td className="mono muted">{row.publicIp || '—'}</td>
                      <td className="mono muted">{relTime(row.launched)}</td>
                      <td>
                        <RowMenu items={[
                          row.state === 'running'
                            ? { label: 'Stop', icon: Icons.IconStop, onClick: () => onAction(row.id, 'stop') }
                            : { label: 'Start', icon: Icons.IconPlay, onClick: () => onAction(row.id, 'start') },
                          { label: 'Reboot', icon: Icons.IconRefresh, onClick: () => onAction(row.id, 'reboot') },
                          { label: 'Connect', icon: Icons.IconTerminal, onClick: () => { setTerminalTarget({ type: 'ec2', instance: row }); setCurrent('terminal'); } },
                          'divider',
                          { label: 'Terminate', icon: Icons.IconX, danger: true, onClick: () => onAction(row.id, 'terminate') },
                        ]} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {loading && <div className="muted" style={{ padding: '8px 16px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}><Spinner size={12} /> Refreshing…</div>}
        </Card>
      </div>

      {showLaunch && <LaunchModal onClose={() => setShowLaunch(false)} onLaunch={onLaunch} />}
    </>
  );
}

function LaunchModal({ onClose, onLaunch }) {
  const [name, setName] = useState('my-server');
  const [ami, setAmi] = useState(AMIS[0].id);
  const [type, setType] = useState('t3.small');
  const [pubIp, setPubIp] = useState(true);

  return (
    <Modal title="Launch instance" onClose={onClose} wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={Icons.IconPlay} onClick={() => onLaunch({ name, ami, type, assignPublicIp: pubIp })}>Launch</Button></>}>
      <div className="field">
        <label className="field-label">Name</label>
        <input autoFocus className="input" value={name} onChange={e => setName(e.target.value)} placeholder="my-server" style={{ height: 34 }} />
        <span className="field-hint">A friendly tag for this instance.</span>
      </div>
      <div className="field">
        <label className="field-label">Image (AMI)</label>
        <div className="radio-grid">
          {AMIS.map(a => (
            <div key={a.id} className={`radio-card ${ami === a.id ? 'selected' : ''}`} onClick={() => setAmi(a.id)}>
              <div className="os">{ami === a.id ? <Icons.IconCheck size={14} /> : <span style={{ width: 14, height: 14, border: '1.5px solid var(--border-strong)', borderRadius: '50%', display: 'inline-block' }} />}{a.os}</div>
              <div className="meta">{a.id} · {a.arch} · {a.size}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="field">
        <label className="field-label">Instance type</label>
        <div className="type-picker">
          {TYPES.map(t => (
            <div key={t.id} className={`type-chip ${type === t.id ? 'selected' : ''}`} onClick={() => setType(t.id)}>
              <span className="label">{t.id}</span>
              <span className="spec">{t.cpu} · {t.mem}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="field">
        <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" className="cb" checked={pubIp} onChange={e => setPubIp(e.target.checked)} />
          Assign public IP
        </label>
        <span className="field-hint">Binds a simulated public address from the emulated VPC pool.</span>
      </div>
    </Modal>
  );
}

// ─── S3 ────────────────────────────────────────────────────────────────────
