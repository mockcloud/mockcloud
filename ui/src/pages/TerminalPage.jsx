import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Card, Empty, Stat, Status, Breadcrumb, Spinner, MiniChart, RowMenu, Modal, SimpleCreateModal, formatBytes, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { TerminalView } from '../components/Terminal.jsx';
import { api } from '../api.js';

function stateKind(s) {
  return { running:'ok', pending:'pending', stopped:'stopped', terminated:'err' }[s] || 'stopped';
}

export function TerminalPage({ target, pushToast, onBack }) {
  const [sessionId, setSessionId] = useState(null);
  const [error, setError]         = useState(null);
  const [loading, setLoading]     = useState(true);

  const isCli = target?.type === 'cli';
  const inst  = target?.instance;

  useEffect(() => {
    let cancelled = false;
    let createdId = null;
    setLoading(true); setError(null); setSessionId(null);

    api.terminal.create(target?.type || 'cli', inst?.id)
      .then(d => {
        if (cancelled) {
          // StrictMode double-invoke: cleanup already ran, discard this session
          api.terminal.close(d.sessionId).catch(() => {});
        } else {
          createdId = d.sessionId;
          setSessionId(d.sessionId);
          setLoading(false);
        }
      })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });

    return () => {
      cancelled = true;
      if (createdId) { api.terminal.close(createdId).catch(() => {}); createdId = null; }
    };
  }, [target?.type, inst?.id]);

  const title    = isCli ? 'Local Cloud CLI' : `${inst?.name || inst?.id} — shell`;
  const subtitle = isCli ? 'us-east-1 · localhost:4566' : `${inst?.type} · ${inst?.os}`;

  const breadcrumb = isCli
    ? ['Console Home', 'Terminal', 'CLI Shell']
    : ['Console Home', { label:'EC2', onClick: onBack }, inst?.name || inst?.id || '—', 'Connect'];

  return (
    <>
      <Breadcrumb items={breadcrumb} />
      <div className="page" style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 104px)' }}>
        <div className="page-header" style={{ flexShrink:0 }}>
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconTerminal size={20} /></div>
            <div>
              <h1 className="page-title">{isCli ? 'Terminal' : 'Instance Shell'}</h1>
              <p className="page-subtitle">
                {isCli
                  ? 'Shell pre-configured with AWS_ENDPOINT_URL=http://localhost:4566'
                  : `Connected to ${inst?.name || inst?.id} (${inst?.os}) via docker exec`}
              </p>
            </div>
          </div>
          <div className="page-actions">
            {!isCli && inst && (
              <div style={{ display:'flex', gap:8, alignItems:'center', fontSize:12, color:'var(--fg-muted)' }}>
                <Status kind={inst.containerId ? 'ok' : 'warn'}>
                  {inst.containerId ? 'Docker' : 'Simulated'}
                </Status>
                <span className="mono">{inst.privateIp}</span>
              </div>
            )}
            <Button onClick={onBack}>Back</Button>
          </div>
        </div>

        <div style={{ flex:1, minHeight:0, borderRadius:10, overflow:'hidden' }}>
          {loading && (
            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', gap:10, color:'var(--fg-muted)', background:'#0d1117', borderRadius:10 }}>
              <Spinner /> Starting session…
            </div>
          )}
          {error && (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:12, background:'#0d1117', borderRadius:10, color:'#f85149', fontFamily:'var(--font-mono)', fontSize:13, padding:32, textAlign:'center' }}>
              <Icons.IconX size={32} style={{ color:'#f85149' }} />
              <div style={{ fontWeight:600, fontSize:15 }}>Failed to start terminal</div>
              <div style={{ color:'#e6edf3', maxWidth:480, lineHeight:1.6 }}>{error}</div>
              <Button onClick={onBack} style={{ marginTop:8 }}>Go back</Button>
            </div>
          )}
          {!loading && !error && sessionId && (
            <TerminalView sessionId={sessionId} title={title} subtitle={subtitle} onClose={onBack} />
          )}
        </div>
      </div>
    </>
  );
}

// ─── Billing ─────────────────────────────────────────────────────────────────
