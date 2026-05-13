import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, Empty, Stat, Breadcrumb, Spinner, Modal, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

export function SESPage({ pushToast }) {
  const [emails, setEmails]         = useState([]);
  const [identities, setIdentities] = useState([]);
  const [loading, setLoading]       = useState(false);
  const [tab, setTab]               = useState('emails');
  const [showVerify, setShowVerify] = useState(false);
  const [sel, setSel]               = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [e, i] = await Promise.all([api.ses.emails(), api.ses.identities()]);
      setEmails(e.emails || []);
      setIdentities(i.identities || []);
    } catch(e) { pushToast({ kind:'err', title:'SES error', body:e.message }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const clearEmails = async () => {
    try { await api.ses.clearEmails(); pushToast({ kind:'ok', title:'Inbox cleared' }); load(); }
    catch(e) { pushToast({ kind:'err', title:'Error', body:e.message }); }
  };

  const deleteIdentity = async (email, e) => {
    e.stopPropagation();
    try { await api.ses.deleteIdentity(email); pushToast({ kind:'ok', title:'Identity removed', body:email }); load(); }
    catch(e) { pushToast({ kind:'err', title:'Error', body:e.message }); }
  };

  return (
    <>
      <Breadcrumb items={['Console Home', 'SES', tab === 'emails' ? 'Email Inbox' : 'Identities']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconCloud size={20} /></div>
            <div>
              <h1 className="page-title">Simple Email Service</h1>
              <p className="page-subtitle">All emails sent by your app are captured here</p>
            </div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            {tab === 'emails' && emails.length > 0 && <Button onClick={clearEmails}>Clear inbox</Button>}
            {tab === 'identities' && <Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowVerify(true)}>Verify email</Button>}
          </div>
        </div>

        <div className="stats-row">
          <Stat label="Emails captured" value={emails.length} />
          <Stat label="Verified identities" value={identities.length} tint="ok" />
        </div>

        <div style={{display:'flex',gap:8,marginBottom:12}}>
          {['emails','identities'].map(t => (
            <button key={t} className={`tab ${tab===t?'active':''}`} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase()+t.slice(1)}
            </button>
          ))}
        </div>

        {tab === 'emails' && (
          <div style={{display:'flex',gap:12}}>
            <Card title="Inbox" count={emails.length} bodyPad={false} style={{flex:'0 0 340px'}}>
              {emails.length === 0
                ? <Empty icon={Icons.IconCloud} title="No emails" message="Emails sent via SES appear here." />
                : emails.map(e => (
                  <div key={e.messageId} className={`nav-item ${sel?.messageId===e.messageId?'active':''}`} style={{cursor:'pointer',padding:'10px 16px',borderBottom:'1px solid var(--border)'}} onClick={() => setSel(e)}>
                    <div style={{fontWeight:500,fontSize:13}}>{e.subject || '(no subject)'}</div>
                    <div className="muted" style={{fontSize:11,marginTop:2}}>{e.from} → {e.to?.[0]}</div>
                    <div className="muted mono" style={{fontSize:10,marginTop:2}}>{relTime(e.sent)}</div>
                  </div>
                ))
              }
            </Card>
            <Card title={sel ? sel.subject || '(no subject)' : 'Select an email'} style={{flex:1}}>
              {sel ? (
                <div style={{fontFamily:'monospace',fontSize:12,lineHeight:1.8}}>
                  <div><strong>From:</strong> {sel.from}</div>
                  <div><strong>To:</strong> {sel.to?.join(', ')}</div>
                  <div><strong>Subject:</strong> {sel.subject}</div>
                  <div><strong>Sent:</strong> {new Date(sel.sent).toLocaleString()}</div>
                  <hr style={{margin:'12px 0',border:'none',borderTop:'1px solid var(--border)'}} />
                  <pre style={{whiteSpace:'pre-wrap',margin:0}}>{sel.body || sel.html || '(empty body)'}</pre>
                </div>
              ) : <div className="muted" style={{padding:16}}>Select an email from the inbox to preview it.</div>}
            </Card>
          </div>
        )}

        {tab === 'identities' && (
          <Card title="Verified Identities" count={identities.length} bodyPad={false}>
            {identities.length === 0
              ? <Empty icon={Icons.IconCloud} title="No identities" message="Verify an email address to send from it." actions={<Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowVerify(true)}>Verify email</Button>} />
              : (
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead><tr><th>Email</th><th>Status</th><th></th></tr></thead>
                    <tbody>
                      {identities.map(i => (
                        <tr key={i.email}>
                          <td className="mono">{i.email}</td>
                          <td><span style={{color:'var(--ok)'}}>Verified</span></td>
                          <td><button className="btn btn-ghost btn-sm" onClick={e => deleteIdentity(i.email, e)}>Remove</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </Card>
        )}
      </div>

      {showVerify && <VerifyModal onClose={() => setShowVerify(false)} onVerified={() => { setShowVerify(false); load(); }} pushToast={pushToast} />}
    </>
  );
}

function VerifyModal({ onClose, onVerified, pushToast }) {
  const [email, setEmail]   = useState('');
  const [loading, setLoading] = useState(false);
  const verify = async () => {
    if (!email) return;
    setLoading(true);
    try { await api.ses.verifyIdentity(email); pushToast({ kind:'ok', title:'Identity verified', body:email }); onVerified(); }
    catch(e) { pushToast({ kind:'err', title:'Error', body:e.message }); }
    finally { setLoading(false); }
  };
  return (
    <Modal title="Verify email identity" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!email||loading} onClick={verify}>{loading?'Verifying…':'Verify'}</Button></>}>
      <div className="field">
        <label className="field-label">Email address</label>
        <input autoFocus className="input" value={email} onChange={e => setEmail(e.target.value)} placeholder="hello@example.com" style={{height:34}} />
      </div>
    </Modal>
  );
}
