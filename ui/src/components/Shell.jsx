// components/Shell.jsx — Topbar and Sidebar
import React, { useState } from 'react';
import * as Icons from './Icons.jsx';
import { Modal } from './UI.jsx';
import { api } from '../api.js';

export function Topbar({ theme, setTheme, openCmd, version, pushToast }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <div className="topbar">
      <div className="hstack" style={{ gap: 24 }}>
        <div className="brand">
          <div className="brand-mark">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1" y="3" width="10" height="4" rx="1.5" fill="currentColor" opacity="0.55"/>
              <rect x="5" y="9" width="10" height="4" rx="1.5" fill="currentColor"/>
            </svg>
          </div>
          MockCloud
          {version && <span className="brand-sub">/ v{version}</span>}
        </div>
        <button className="cmd-trigger" onClick={openCmd}>
          <Icons.IconSearch size={14} />
          Search services, resources, docs…
          <span className="kbd">⌘K</span>
        </button>
      </div>

      <div className="topbar-right">
        <button className="pill env" title="Environment">
          <span className="dot" />
          dev-local
          <Icons.IconChevDown size={12} className="chev" />
        </button>
        <button className="pill" title="Region">
          <span className="dot" />
          us-east-1
          <Icons.IconChevDown size={12} className="chev" />
        </button>
        <button className="icon-btn" title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Icons.IconSun size={15} /> : <Icons.IconMoon size={15} />}
        </button>
        <button className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
          <Icons.IconSettings size={15} />
        </button>
        <div className="avatar" title="mockcloud">MC</div>
      </div>
      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} pushToast={pushToast} />
      )}
    </div>
  );
}

function SettingsModal({ onClose, pushToast }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function doReset() {
    setBusy(true);
    try {
      await api.reset();
      pushToast?.({
        kind: 'success',
        title: 'All resources reset',
        body: 'Cleared store',
      });
      onClose();
    } catch (e) {
      pushToast?.({ kind: 'error', title: 'Reset failed', body: e?.message || 'Unknown error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Settings" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Reset all resources</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12, lineHeight: 1.5 }}>
            Permanently delete every resource across all services (EC2, S3, Lambda, DynamoDB, IAM, etc.),
            clear the activity trail, and terminate any Docker containers spawned by MockCloud.
            This cannot be undone.
          </div>
          {!confirming ? (
            <button
              className="btn"
              style={{ background: 'var(--danger, #dc2626)', color: '#fff', borderColor: 'transparent' }}
              onClick={() => setConfirming(true)}
            >
              Reset all resources…
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Are you sure?</span>
              <button
                className="btn"
                style={{ background: 'var(--danger, #dc2626)', color: '#fff', borderColor: 'transparent' }}
                onClick={doReset}
                disabled={busy}
              >
                {busy ? 'Resetting…' : 'Yes, wipe everything'}
              </button>
              <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

const NAV = [
  { section: null, items: [{ id:'home', label:'Home', icon: Icons.IconHome }] },
  { section:'Compute', items: [
    { id:'ec2',    label:'EC2',    icon: Icons.IconEC2 },
    { id:'lambda', label:'Lambda', icon: Icons.IconLambda },
  ]},
  { section:'Storage', items: [
    { id:'s3', label:'S3', icon: Icons.IconS3 },
  ]},
  { section:'Database', items: [
    { id:'dynamodb', label:'DynamoDB', icon: Icons.IconDB },
  ]},
  { section:'Messaging', items: [
    { id:'sns',         label:'SNS',         icon: Icons.IconSNS },
    { id:'sqs',         label:'SQS',         icon: Icons.IconSQS },
    { id:'eventbridge', label:'EventBridge',  icon: Icons.IconSparkles },
  ]},
  { section:'Security', items: [
    { id:'secrets', label:'Secrets Manager', icon: Icons.IconSecrets },
    { id:'iam',     label:'IAM',             icon: Icons.IconIAM },
  ]},
  { section:'Management', items: [
    { id:'watch',    label:'CloudWatch',  icon: Icons.IconWatch },
    { id:'trail',    label:'CloudTrail',  icon: Icons.IconTrail },
    { id:'terminal', label:'Terminal',    icon: Icons.IconTerminal },
  ]},
  { section:'Billing', items: [
    { id:'billing', label:'Billing & Cost', icon: Icons.IconBilling },
  ]},
];

export function Sidebar({ current, setCurrent, counts = {} }) {
  return (
    <nav className="sidebar">
      {NAV.map((group, i) => (
        <div className={group.section ? 'nav-group' : ''} key={i}>
          {group.section && <div className="nav-label">{group.section}</div>}
          {group.items.map(it => (
            <button key={it.id} className={`nav-item ${current === it.id ? 'active' : ''}`} onClick={() => setCurrent(it.id)}>
              <it.icon size={15} className="nav-icon" />
              {it.label}
              {counts[it.id] !== undefined && <span className="nav-tag">{counts[it.id]}</span>}
            </button>
          ))}
        </div>
      ))}
      <div className="sidebar-footer">
        <span className="status-dot" />
        <span>Daemon healthy · <span className="mono">:4566</span></span>
      </div>
    </nav>
  );
}
