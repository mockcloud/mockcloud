// components/UI.jsx — shared primitive components matching the design system
import React, { useState, useEffect, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import * as Icons from './Icons.jsx';

export function Button({ variant = 'secondary', size, icon: Icon, children, ...rest }) {
  const cls = ['btn', `btn-${variant}`, size ? `btn-${size}` : ''].filter(Boolean).join(' ');
  return (
    <button className={cls} {...rest}>
      {Icon && <Icon size={14} />}
      {children}
    </button>
  );
}

export function Status({ kind = 'ok', children }) {
  return (
    <span className={`status status-${kind}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

export function Card({ title, count, actions, children, bodyPad = true }) {
  return (
    <div className="card">
      {(title || actions) && (
        <div className="card-header">
          <div className="card-title">
            {title}
            {count !== undefined && <span className="card-count">{count}</span>}
          </div>
          {actions && <div className="hstack">{actions}</div>}
        </div>
      )}
      <div className={`card-body ${bodyPad ? '' : 'p0'}`}>{children}</div>
    </div>
  );
}

export function Empty({ icon: Icon = Icons.IconCloud, title, message, actions }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon size={22} /></div>
      <h4>{title}</h4>
      {message && <p>{message}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, suffix, tint }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {tint === 'ok'   && <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--ok)', display:'inline-block' }} />}
        {tint === 'warn' && <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--warn)', display:'inline-block' }} />}
        {tint === 'err'  && <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--err)', display:'inline-block' }} />}
        {label}
      </div>
      <div className="stat-value">
        {value}
        {suffix && <span className="stat-suffix">{suffix}</span>}
      </div>
    </div>
  );
}

export function Breadcrumb({ items }) {
  return (
    <div className="breadcrumb">
      {items.map((it, i) => {
        const isLast = i === items.length - 1;
        const label  = typeof it === 'string' ? it : it.label;
        const onClick = typeof it === 'string' ? undefined : it.onClick;
        return (
          <React.Fragment key={i}>
            {i > 0 && <Icons.IconChevRight size={12} className="sep" />}
            {!isLast && onClick
              ? <button onClick={onClick} style={{ background:'none', border:0, padding:0, color:'var(--fg-muted)', cursor:'pointer', font:'inherit', fontSize:12 }}
                  onMouseEnter={e=>e.currentTarget.style.color='var(--accent)'}
                  onMouseLeave={e=>e.currentTarget.style.color='var(--fg-muted)'}>{label}</button>
              : <span className={isLast ? 'current' : ''}>{label}</span>
            }
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function Spinner({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ animation: 'spin 1s linear infinite', display:'block' }}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" fill="none" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function MiniChart({ data, tint = 'var(--accent)' }) {
  const w = 100, h = 40;
  const max = Math.max(...data) || 1;
  const pts = data.map((v, i) => [i * (w / (data.length - 1)), h - (v / max) * (h - 4) - 2]);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${path} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 90 }} preserveAspectRatio="none">
      <path d={area} fill={tint} opacity="0.12" />
      <path d={path} fill="none" stroke={tint} strokeWidth="1.5" />
    </svg>
  );
}

export function RowMenu({ items }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos]   = useState({ top: 0, right: 0 });
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const h = (e) => {
      if (btnRef.current && !btnRef.current.closest('[data-rowmenu]')?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen(v => !v);
  };

  return (
    <div data-rowmenu="" style={{ position: 'relative', display: 'inline-block' }}>
      <button ref={btnRef} className="btn btn-ghost btn-icon btn-sm" onClick={toggle} aria-label="Actions">
        <Icons.IconMore size={14} />
      </button>
      {open && ReactDOM.createPortal(
        <div onMouseDown={e => e.stopPropagation()} style={{
          position:'fixed', top: pos.top, right: pos.right,
          background:'var(--bg-elev)', border:'1px solid var(--border)',
          borderRadius:'var(--radius-sm)', boxShadow:'var(--shadow-lg)',
          padding:4, minWidth:160, zIndex:9999, fontSize:13
        }}>
          {items.map((item, i) => item === 'divider'
            ? <div key={i} style={{ height:1, background:'var(--border)', margin:'4px 0' }} />
            : (
              <button key={i} onClick={() => { item.onClick(); setOpen(false); }}
                style={{ display:'flex', alignItems:'center', gap:8, width:'100%', padding:'7px 10px',
                         borderRadius:4, fontSize:12.5, color: item.danger ? 'var(--err)' : 'var(--fg)',
                         textAlign:'left', transition:'background 120ms', background:'transparent', border:0, cursor:'pointer' }}
                onMouseEnter={e => e.currentTarget.style.background = item.danger ? 'var(--err-soft)' : 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                {item.icon && <item.icon size={13} />}
                {item.label}
              </button>
            )
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

export function Modal({ title, onClose, footer, wide, children }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="icon-btn" onClick={onClose}><Icons.IconX size={15} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function CmdK({ open, onClose, onNavigate }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) { setQ(''); setIdx(0); setTimeout(() => inputRef.current?.focus(), 10); }
  }, [open]);

  const items = useMemo(() => [
    { id:'home',     label:'Home',               icon: Icons.IconHome,    sub:'h' },
    { id:'ec2',      label:'EC2 — Instances',     icon: Icons.IconEC2,     sub:'e' },
    { id:'s3',       label:'S3 — Buckets',        icon: Icons.IconS3,      sub:'s' },
    { id:'lambda',   label:'Lambda — Functions',  icon: Icons.IconLambda,  sub:'l' },
    { id:'dynamodb', label:'DynamoDB — Tables',   icon: Icons.IconDB,      sub:'d' },
    { id:'sns',      label:'SNS — Topics',        icon: Icons.IconSNS },
    { id:'sqs',      label:'SQS — Queues',        icon: Icons.IconSQS },
    { id:'eventbridge', label:'EventBridge — Rules & buses', icon: Icons.IconSparkles },
    { id:'iam',      label:'IAM — Users & roles', icon: Icons.IconIAM },
    { id:'secrets',  label:'Secrets Manager',     icon: Icons.IconSecrets },
    { id:'watch',    label:'CloudWatch — Metrics',   icon: Icons.IconWatch },
    { id:'trail',    label:'CloudTrail — Audit log', icon: Icons.IconTrail },
    { id:'terminal', label:'Terminal — CLI Shell',   icon: Icons.IconTerminal },
    { id:'billing',  label:'Billing & Cost',         icon: Icons.IconBilling },
  ].filter(x => !q || x.label.toLowerCase().includes(q.toLowerCase())), [q]);

  useEffect(() => {
    if (!open) return;
    const h = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(v => Math.min(items.length - 1, v + 1)); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); setIdx(v => Math.max(0, v - 1)); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) { onNavigate(items[idx].id); onClose(); } }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, items, idx, onClose, onNavigate]);

  if (!open) return null;
  return (
    <div className="modal-scrim" onMouseDown={ev => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div className="cmdk" onMouseDown={ev => ev.stopPropagation()}>
        <div className="cmdk-search">
          <Icons.IconSearch size={16} />
          <input ref={inputRef} placeholder="Type a command or search…" value={q} onChange={ev => { setQ(ev.target.value); setIdx(0); }} />
          <span className="kbd">esc</span>
        </div>
        <div className="cmdk-list">
          <div className="cmdk-label">Navigate</div>
          {items.map((it, i) => (
            <div key={it.id} className={`cmdk-item ${i === idx ? 'active' : ''}`}
              onClick={() => { onNavigate(it.id); onClose(); }}
              onMouseEnter={() => setIdx(i)}
            >
              <it.icon size={15} className="item-icon" />
              {it.label}
              {it.sub && <span className="cmdk-sub">{it.sub}</span>}
            </div>
          ))}
          {items.length === 0 && <div style={{ padding:16, fontSize:12.5, color:'var(--fg-muted)' }}>No results.</div>}
        </div>
      </div>
    </div>
  );
}

export function Toasts({ toasts }) {
  return (
    <div className="toast-area">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind || ''}`}>
          <div className="bar" />
          <div style={{ flex:1 }}>
            <div className="t-title">{t.title}</div>
            {t.body && <div className="t-body">{t.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SimpleCreateModal({ title, label, placeholder, onClose, onCreate, hint }) {
  const [v, setV] = useState('');
  return (
    <Modal title={title} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!v} onClick={() => onCreate(v)}>Create</Button></>}>
      <div className="field">
        <label className="field-label">{label}</label>
        <input autoFocus className="input" value={v} onChange={e => setV(e.target.value)} placeholder={placeholder} style={{ height:34 }} onKeyDown={e => e.key==='Enter' && v && onCreate(v)} />
        {hint && <span className="field-hint">{hint}</span>}
      </div>
    </Modal>
  );
}

export function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024*1024) return `${(b/1024).toFixed(1)} KB`;
  if (b < 1024*1024*1024) return `${(b/1024/1024).toFixed(1)} MB`;
  return `${(b/1024/1024/1024).toFixed(2)} GB`;
}

export function relTime(ts) {
  if (!ts) return '—';
  const ms = Date.now() - ts;
  if (ms < 60000) return `${Math.max(1, Math.floor(ms/1000))}s ago`;
  if (ms < 3600000) return `${Math.floor(ms/60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms/3600000)}h ago`;
  return `${Math.floor(ms/86400000)}d ago`;
}
