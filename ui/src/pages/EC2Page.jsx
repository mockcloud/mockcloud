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

// EC2 execution mode — display labels only; wire values stay 'lite'/'vmm'
// so the CLI flag --ec2=docker|simulated and existing API contract are unchanged.
const MODES = [
  { value: 'lite', label: 'Simulated', hint: 'Fake state, no Docker required' },
  { value: 'vmm', label: 'Docker', hint: 'Real containers via Docker daemon' },
];
const modeLabel = v => MODES.find(m => m.value === v)?.label || v;

function ModeToggle({ mode, onChange, dockerAvailable, onDockerUnavailableClick, disabled }) {
  return (
    <div className="mode-toggle" role="group" aria-label="EC2 execution mode">
      {MODES.map(m => {
        const isActive = mode === m.value;
        const isDocker = m.value === 'vmm';
        const isBlocked = isDocker && dockerAvailable === false;
        const handleClick = () => {
          if (disabled || isActive) return;
          if (isBlocked) { onDockerUnavailableClick?.(); return; }
          onChange(m.value);
        };
        const title = isBlocked
          ? 'Docker daemon not detected — click for details'
          : m.hint;
        return (
          <button
            key={m.value}
            type="button"
            className={`mode-toggle-btn ${isActive ? 'active' : ''} ${isBlocked ? 'blocked' : ''}`}
            onClick={handleClick}
            disabled={disabled}
            title={title}
            aria-pressed={isActive}
          >
            {isDocker && dockerAvailable !== null && (
              <span className={`mode-dot ${dockerAvailable ? 'up' : 'down'}`} aria-hidden />
            )}
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function stateKind(s) {
  return { running: 'ok', pending: 'pending', stopped: 'stopped', terminated: 'err' }[s] || 'stopped';
}

export function EC2Page({ pushToast, setCurrent, setTerminalTarget, status }) {
  const [instances, setInstances] = useState([]);
  const [q, setQ] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [showLaunch, setShowLaunch] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('vmm');
  const [dockerAvailable, setDockerAvailable] = useState(null); // null = unknown yet
  const [dockerHint, setDockerHint] = useState('');
  const [dockerModalOpen, setDockerModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.ec2.instances(); setInstances(d.instances || []); }
    catch (e) { pushToast({ kind: 'err', title: 'EC2 error', body: e.message }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  // Sync local state from the polled status. Detects three transitions:
  //   1. mode change (e.g. CLI rewrote it, or auto-fallback flipped to lite)
  //   2. dockerAvailable change (UI dot follows daemon up/down events)
  //   3. auto-fallback: status flips us from vmm→lite while docker went down
  useEffect(() => {
    if (!status) return;
    const wasVmm = mode === 'vmm';
    const nowLite = status.ec2Mode === 'lite';
    const dockerDown = status.dockerAvailable === false;
    if (status.ec2Mode) setMode(status.ec2Mode);
    if (typeof status.dockerAvailable === 'boolean') {
      setDockerAvailable(status.dockerAvailable);
    }
    // Auto-fallback toast — only when we observe the transition, not on initial load.
    if (wasVmm && nowLite && dockerDown) {
      pushToast({
        kind: 'warn',
        title: 'Docker became unavailable',
        body: 'Switched to Simulated mode. New instances will be in-memory only.',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.ec2Mode, status?.dockerAvailable]);

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

  const onModeChange = async (next) => {
    // If switching TO docker, do a fresh client-side ping first so the toggle
    // doesn't optimistically flip and then snap back. Server will also guard.
    if (next === 'vmm') {
      try {
        const probe = await api.ec2.dockerStatus();
        if (!probe.available) {
          setDockerHint(probe.hint || '');
          setDockerAvailable(false);
          setDockerModalOpen(true);
          return;
        }
      } catch (e) {
        pushToast({ kind: 'err', title: 'Docker check failed', body: e.message });
        return;
      }
    }

    const prev = mode;
    setMode(next); // optimistic flip
    try {
      await api.ec2.setMode(next);
      pushToast({ kind: 'ok', title: 'EC2 mode changed', body: `Now: ${modeLabel(next)}` });
    } catch (e) {
      setMode(prev); // rollback
      // Server returns 409 + hint when Docker unavailable — show the popup
      // with the platform-specific instructions instead of a generic toast.
      if (e.status === 409 && e.body?.error === 'docker_unavailable') {
        setDockerHint(e.body.hint || '');
        setDockerAvailable(false);
        setDockerModalOpen(true);
      } else {
        pushToast({ kind: 'err', title: 'Mode change failed', body: e.message });
      }
    }
  };

  const onDockerUnavailableClick = () => {
    // Refresh the hint from the latest probe before showing the modal so the
    // user gets the most accurate platform-specific instructions.
    api.ec2.dockerStatus()
      .then(p => { setDockerHint(p.hint || ''); setDockerAvailable(p.available); })
      .catch(() => { });
    setDockerModalOpen(true);
  };

  const onRetryDocker = async () => {
    try {
      const probe = await api.ec2.dockerStatus();
      setDockerAvailable(probe.available);
      setDockerHint(probe.hint || '');
      if (probe.available) {
        setDockerModalOpen(false);
        pushToast({ kind: 'ok', title: 'Docker detected', body: 'You can switch to Docker mode now.' });
      }
    } catch (e) {
      pushToast({ kind: 'err', title: 'Recheck failed', body: e.message });
    }
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
            <ModeToggle
              mode={mode}
              onChange={onModeChange}
              dockerAvailable={dockerAvailable}
              onDockerUnavailableClick={onDockerUnavailableClick}
            />
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

      {showLaunch && <LaunchModal onClose={() => setShowLaunch(false)} onLaunch={onLaunch} mode={mode} />}
      {dockerModalOpen && (
        <Modal title="Docker is not running" onClose={() => setDockerModalOpen(false)}
          footer={<>
            <Button variant="ghost" onClick={() => setDockerModalOpen(false)}>Close</Button>
            <Button variant="primary" icon={Icons.IconRefresh} onClick={onRetryDocker}>Recheck</Button>
          </>}>
          <p style={{ margin: '0 0 12px', color: 'var(--muted)', lineHeight: 1.55 }}>
            Docker mode launches each EC2 instance as a real container. The Docker daemon isn't
            reachable right now, so MockCloud is staying in Simulated mode.
          </p>
          <div className="docker-hint-box">
            <strong>To enable Docker mode:</strong>
            <p style={{ margin: '6px 0 0', lineHeight: 1.5 }}>{dockerHint || 'Start the Docker daemon and try again.'}</p>
          </div>
          <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--muted)' }}>
            Simulated mode works without Docker — instances are in-memory only, but every other
            MockCloud feature is fully available.
          </p>
        </Modal>
      )}
    </>
  );
}

function LaunchModal({ onClose, onLaunch, mode }) {
  const [name, setName] = useState('my-server');
  const [ami, setAmi] = useState(AMIS[0].id);
  const [type, setType] = useState('t3.small');
  const [pubIp, setPubIp] = useState(true);

  return (
    <Modal title="Launch instance" onClose={onClose} wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={Icons.IconPlay} onClick={() => onLaunch({ name, ami, type, assignPublicIp: pubIp })}>Launch</Button></>}>
      <div className="launch-mode-banner" data-mode={mode}>
        <div className="launch-mode-banner-row">
          <span className="launch-mode-label">Execution mode</span>
          <span className={`launch-mode-pill ${mode}`}>{modeLabel(mode)}</span>
        </div>
        <span className="launch-mode-hint">
          {mode === 'vmm'
            ? 'This instance will run as a real Docker container. Requires Docker daemon.'
            : 'Simulated instance — state only, no container will be created.'}
        </span>
      </div>
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
