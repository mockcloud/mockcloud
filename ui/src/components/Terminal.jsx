import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api.js';

const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
const stripAnsi = s => s.replace(ANSI_RE, '');

// status: connecting | live | busy | exited | error
export function TerminalView({ sessionId, title, subtitle, onClose }) {
  const [output, setOutput]   = useState('');
  const [input, setInput]     = useState('');
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [status, setStatus]   = useState('connecting');
  const outputRef = useRef(null);
  const inputRef  = useRef(null);
  const atBottom  = useRef(true);

  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(api.terminal.streamUrl(sessionId));

    es.onopen = () => {
      setStatus('live');
      setTimeout(() => inputRef.current?.focus(), 50);
    };

    es.onmessage = e => {
      const chunk = JSON.parse(e.data);
      if (chunk.t === 'x') {
        setStatus('exited');
        es.close();
        return;
      }
      if (chunk.t === 'r') {
        // command finished — re-enable input
        setStatus('live');
        setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }
      const text = stripAnsi(chunk.d);
      setOutput(prev => (prev + text).slice(-300000));
    };

    es.onerror = () => {
      // Only show error if we haven't already exited cleanly
      setStatus(s => s === 'exited' ? 'exited' : 'error');
      es.close();
    };

    return () => { es.close(); };
  }, [sessionId]);

  // Auto-scroll only when already pinned to bottom
  useEffect(() => {
    const el = outputRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  const handleScroll = useCallback(() => {
    const el = outputRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const runCommand = useCallback(async cmd => {
    if (!cmd.trim()) {
      // Empty enter — just show a blank prompt line in output
      setOutput(prev => prev + '\n');
      return;
    }
    setStatus('busy');
    try {
      await api.terminal.exec(sessionId, cmd);
    } catch (err) {
      setOutput(prev => prev + `\r\nError: ${err.message}\r\n`);
      setStatus('live');
    }
  }, [sessionId]);

  const handleKeyDown = useCallback(e => {
    if (e.key === 'Enter') {
      const cmd = input;
      setOutput(prev => prev + `$ ${cmd}\r\n`);
      if (cmd.trim()) setHistory(h => [cmd, ...h.slice(0, 99)]);
      setInput('');
      setHistIdx(-1);
      runCommand(cmd);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHistIdx(i => {
        const next = Math.min(i + 1, history.length - 1);
        if (history[next] != null) setInput(history[next]);
        return next;
      });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHistIdx(i => {
        const next = i - 1;
        setInput(next >= 0 && history[next] ? history[next] : '');
        return Math.max(-1, next);
      });
    } else if (e.ctrlKey && e.key === 'c') {
      if (status === 'busy') {
        api.terminal.interrupt(sessionId).catch(() => {});
        setOutput(prev => prev + '^C\r\n');
        setStatus('live');
      } else {
        setInput('');
      }
    } else if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      setOutput('');
    }
  }, [input, history, histIdx, status, sessionId, runCommand]);

  const statusColor = { connecting:'#e3b341', live:'#3fb950', busy:'#58a6ff', exited:'#8b949e', error:'#f85149' }[status];
  const statusLabel = { connecting:'Connecting…', live:'Ready', busy:'Running…', exited:'Exited', error:'Connection error' }[status];
  const inputDisabled = status !== 'live';

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', background:'#0d1117', borderRadius:10, overflow:'hidden', fontFamily:'"Cascadia Code","Fira Code","JetBrains Mono","SF Mono",Consolas,monospace', fontSize:13, boxShadow:'0 8px 32px rgba(0,0,0,0.5)' }}>

      {/* Titlebar */}
      <div style={{ display:'flex', alignItems:'center', padding:'0 14px', height:40, background:'#161b22', borderBottom:'1px solid #30363d', gap:10, flexShrink:0 }}>
        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
          <span onClick={onClose} title="Close" style={{ width:12, height:12, borderRadius:'50%', background:'#ff5f57', cursor:'pointer', display:'block' }} />
          <span style={{ width:12, height:12, borderRadius:'50%', background:'#ffbd2e', display:'block' }} />
          <span style={{ width:12, height:12, borderRadius:'50%', background:'#28ca41', display:'block' }} />
        </div>
        <div style={{ flex:1, textAlign:'center' }}>
          <span style={{ fontSize:12.5, fontWeight:600, color:'#c9d1d9' }}>{title}</span>
          {subtitle && <span style={{ fontSize:11, color:'#8b949e', marginLeft:8 }}>{subtitle}</span>}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:11 }}>
          <span style={{ width:7, height:7, borderRadius:'50%', background:statusColor, display:'inline-block' }} />
          <span style={{ color:statusColor }}>{statusLabel}</span>
        </div>
      </div>

      {/* Output area */}
      <div ref={outputRef} onScroll={handleScroll}
        onClick={() => !inputDisabled && inputRef.current?.focus()}
        style={{ flex:1, overflowY:'auto', padding:'10px 16px', cursor:'text', minHeight:0, scrollbarWidth:'thin', scrollbarColor:'#30363d #0d1117' }}>
        <pre style={{ margin:0, color:'#e6edf3', whiteSpace:'pre-wrap', wordBreak:'break-all', lineHeight:1.6 }}>{output}</pre>
        {status === 'exited' && (
          <div style={{ marginTop:6, color:'#8b949e', fontStyle:'italic', fontSize:12 }}>— session ended —</div>
        )}
        {status === 'error' && (
          <div style={{ marginTop:6, color:'#f85149', fontSize:12 }}>Connection lost — the daemon may have restarted.</div>
        )}
      </div>

      {/* Input bar */}
      {status !== 'exited' && (
        <div style={{ display:'flex', alignItems:'center', padding:'8px 16px', borderTop:'1px solid #21262d', background:'#0d1117', flexShrink:0, gap:8 }}>
          <span style={{ color: inputDisabled ? '#3a4a3a' : '#3fb950', userSelect:'none', fontWeight:700, fontSize:14 }}>
            {status === 'busy' ? '⟳' : '$'}
          </span>
          <input
            ref={inputRef}
            value={input}
            onChange={e => !inputDisabled && setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={inputDisabled}
            style={{
              flex:1, background:'transparent', border:'none', outline:'none',
              color: inputDisabled ? '#555' : '#e6edf3',
              fontFamily:'inherit', fontSize:'inherit', caretColor:'#3fb950',
            }}
            placeholder={
              status === 'connecting' ? 'Connecting…' :
              status === 'busy'       ? 'Command running… (Ctrl+C to cancel)' :
              status === 'error'      ? 'Disconnected' : ''
            }
            spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off"
          />
          {status === 'live' && (
            <span style={{ fontSize:10.5, color:'#484f58', userSelect:'none', whiteSpace:'nowrap' }}>
              ↑↓ history · Ctrl+L clear
            </span>
          )}
        </div>
      )}
    </div>
  );
}
