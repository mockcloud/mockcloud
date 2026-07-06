import React, { useState, useEffect } from 'react';
import { Button, Breadcrumb, Spinner } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { TerminalView } from '../components/Terminal.jsx';
import { api } from '../api.js';

export function TerminalPage({ onBack }) {
  const [sessionId, setSessionId] = useState(null);
  const [error, setError]         = useState(null);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    let cancelled = false;
    let createdId = null;
    setLoading(true); setError(null); setSessionId(null);

    api.terminal.create()
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
  }, []);

  return (
    <>
      <Breadcrumb items={['Console Home', 'Terminal', 'CLI Shell']} />
      <div className="page" style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 104px)' }}>
        <div className="page-header" style={{ flexShrink:0 }}>
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconTerminal size={20} /></div>
            <div>
              <h1 className="page-title">Terminal</h1>
              <p className="page-subtitle">Shell pre-configured with AWS_ENDPOINT_URL=http://localhost:4566</p>
            </div>
          </div>
          <div className="page-actions">
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
            <TerminalView sessionId={sessionId} title="MockCloud CLI" subtitle="us-east-1 · localhost:4566" onClose={onBack} />
          )}
        </div>
      </div>
    </>
  );
}
