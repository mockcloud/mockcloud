import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, Empty, Stat, Breadcrumb, RowMenu, Modal, SimpleCreateModal, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { api } from '../api.js';

export function SQSPage({ pushToast }) {
  const [queues, setQueues] = useState([]);
  const [sel, setSel] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try { const d = await api.sqs.queues(); setQueues(d.queues || []); }
    catch (e) { pushToast({ kind: 'err', title: 'SQS error', body: e.message }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (sel) {
    return <SQSDetail queue={sel} onBack={() => { setSel(null); load(); }} pushToast={pushToast} />;
  }

  return (
    <>
      <Breadcrumb items={['Console Home', 'SQS', 'Queues']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row"><div className="service-icon"><Icons.IconSQS size={20} /></div>
            <div><h1 className="page-title">SQS queues</h1><p className="page-subtitle">Reliable message queues with at-least-once delivery.</p></div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load}>Refresh</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowCreate(true)}>Create queue</Button>
          </div>
        </div>
        <div className="stats-row">
          <Stat label="Queues" value={queues.length} />
          <Stat label="Messages available" value={queues.reduce((s, q) => s + (q.messagesAvailable || 0), 0)} tint="ok" />
          <Stat label="In flight" value={queues.reduce((s, q) => s + (q.messagesInFlight || 0), 0)} tint="warn" />
        </div>
        <Card title="Queues" count={queues.length} bodyPad={false}>
          {queues.length === 0
            ? <Empty icon={Icons.IconSQS} title="No queues" message="Create a queue to start sending messages." actions={<Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowCreate(true)}>Create queue</Button>} />
            : <table className="tbl">
              <thead><tr><th>Name</th><th>Type</th><th>Available</th><th>In flight</th><th>Created</th><th></th></tr></thead>
              <tbody>{queues.map(q => (
                <tr key={q.url} onClick={() => setSel(q)} style={{ cursor: 'pointer' }}>
                  <td><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Icons.IconSQS size={14} style={{ color: 'var(--accent)' }} /><span style={{ fontWeight: 500 }}>{q.name}</span></div></td>
                  <td><span className="nav-tag">{q.type}</span></td>
                  <td className="mono">{q.messagesAvailable}</td>
                  <td className="mono">{q.messagesInFlight}</td>
                  <td className="mono muted">{relTime(q.created)}</td>
                  <td onClick={e => e.stopPropagation()}>
                    <RowMenu items={[
                      { label: 'Open', icon: Icons.IconChevDown, onClick: () => setSel(q) },
                      'divider',
                      {
                        label: 'Purge messages', icon: Icons.IconRefresh, onClick: async () => {
                          if (!confirm(`Purge all messages from "${q.name}"? This deletes them permanently.`)) return;
                          try { const r = await api.sqs.purge(q.name); pushToast({ kind: 'ok', title: `Purged ${r.purged} message${r.purged === 1 ? '' : 's'}` }); load(); }
                          catch (e) { pushToast({ kind: 'err', title: 'Error', body: e.message }); }
                        }
                      },
                      {
                        label: 'Delete queue', icon: Icons.IconX, danger: true, onClick: async () => {
                          if (!confirm(`Delete queue "${q.name}"?`)) return;
                          try { await api.sqs.delete(q.name); pushToast({ kind: 'ok', title: 'Queue deleted', body: q.name }); load(); }
                          catch (e) { pushToast({ kind: 'err', title: 'Error', body: e.message }); }
                        }
                      },
                    ]} />
                  </td>
                </tr>
              ))}</tbody>
            </table>
          }
        </Card>
      </div>
      {showCreate && <SimpleCreateModal title="Create queue" label="Queue name" placeholder="orders.fifo" hint="Append .fifo for FIFO queues." onClose={() => setShowCreate(false)} onCreate={async name => {
        try { await api.sqs.create(name); pushToast({ kind: 'ok', title: 'Queue created', body: name }); setShowCreate(false); load(); } catch (e) { pushToast({ kind: 'err', title: 'Error', body: e.message }); }
      }} />}
    </>
  );
}

function SQSDetail({ queue, onBack, pushToast }) {
  const [messages, setMessages] = useState([]);
  const [total, setTotal]       = useState(0);
  const [showSend, setShowSend] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await api.sqs.messages(queue.name, 100);
      setMessages(d.messages || []);
      setTotal(d.total || 0);
    } catch (e) {
      pushToast({ kind: 'err', title: 'Error', body: e.message });
    }
  }, [queue.name, pushToast]);

  useEffect(() => { refresh(); }, [refresh]);

  const onReceive = async () => {
    try {
      const r = await api.sqs.receive(queue.name, 1);
      if (r.messages?.length) {
        pushToast({ kind: 'ok', title: 'Received message', body: `${r.messages[0].body.slice(0, 60)}` });
      } else {
        pushToast({ kind: 'info', title: 'No messages available' });
      }
      refresh();
    } catch (e) {
      pushToast({ kind: 'err', title: 'Error', body: e.message });
    }
  };

  const onPurge = async () => {
    if (!confirm(`Purge all ${total} messages from "${queue.name}"?`)) return;
    try {
      const r = await api.sqs.purge(queue.name);
      pushToast({ kind: 'ok', title: `Purged ${r.purged} message${r.purged === 1 ? '' : 's'}` });
      refresh();
    } catch (e) {
      pushToast({ kind: 'err', title: 'Error', body: e.message });
    }
  };

  const onDeleteMsg = async (handle) => {
    try {
      await api.sqs.deleteMessage(queue.name, handle);
      pushToast({ kind: 'ok', title: 'Message deleted' });
      refresh();
    } catch (e) {
      pushToast({ kind: 'err', title: 'Error', body: e.message });
    }
  };

  return (
    <>
      <Breadcrumb items={[
        'Console Home',
        { label: 'SQS', onClick: onBack },
        { label: 'Queues', onClick: onBack },
        queue.name,
      ]} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div className="service-icon"><Icons.IconSQS size={20} /></div>
            <div>
              <h1 className="page-title">{queue.name}</h1>
              <p className="page-subtitle"><span className="nav-tag">{queue.type}</span> · {total} message{total === 1 ? '' : 's'} · <span className="mono">{queue.url}</span></p>
            </div>
          </div>
          <div className="page-actions">
            <Button onClick={onBack}>Back</Button>
            <Button icon={Icons.IconRefresh} onClick={refresh}>Refresh</Button>
            <Button onClick={onReceive}>Receive</Button>
            <Button onClick={onPurge} disabled={total === 0}>Purge</Button>
            <Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowSend(true)}>Send message</Button>
          </div>
        </div>

        <div className="stats-row">
          <Stat label="Available" value={messages.filter(m => m.visible).length} tint="ok" />
          <Stat label="In flight" value={messages.filter(m => !m.visible).length} tint="warn" />
          <Stat label="Total" value={total} />
        </div>

        <Card title="Messages" count={messages.length} bodyPad={false}>
          {messages.length === 0
            ? <Empty icon={Icons.IconSQS} title="Queue is empty" message="Send a message or wait for one to arrive." actions={<Button variant="primary" icon={Icons.IconPlus} onClick={() => setShowSend(true)}>Send message</Button>} />
            : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th style={{ width: 100 }}>Status</th><th>Body</th><th style={{ width: 130 }}>Sent</th><th style={{ width: 80 }}></th></tr></thead>
                  <tbody>
                    {messages.map(m => (
                      <tr key={m.id}>
                        <td>
                          <span style={{ color: m.visible ? 'var(--ok)' : 'var(--warn)', fontSize: 12 }}>
                            {m.visible ? '● available' : '◐ in-flight'}
                          </span>
                        </td>
                        <td className="mono" style={{ fontSize: 12, wordBreak: 'break-all', maxWidth: 600 }}>{m.body}</td>
                        <td className="mono muted">{relTime(m.sent)}</td>
                        <td>
                          <button className="btn btn-ghost btn-sm" onClick={() => onDeleteMsg(m.receiptHandle)}>Delete</button>
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
      {showSend && <SendMessageModal queueName={queue.name} onClose={() => setShowSend(false)} onSent={() => { setShowSend(false); refresh(); }} pushToast={pushToast} />}
    </>
  );
}

function SendMessageModal({ queueName, onClose, onSent, pushToast }) {
  const [body, setBody] = useState('{\n  "hello": "world"\n}');
  const [loading, setLoading] = useState(false);
  const send = async () => {
    setLoading(true);
    try {
      await api.sqs.send(queueName, body);
      pushToast({ kind: 'ok', title: 'Message sent', body: queueName });
      onSent();
    } catch (e) {
      pushToast({ kind: 'err', title: 'Error', body: e.message });
    } finally {
      setLoading(false);
    }
  };
  return (
    <Modal title={`Send to ${queueName}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!body || loading} onClick={send}>{loading ? 'Sending…' : 'Send message'}</Button></>}>
      <div className="field">
        <label className="field-label">Message body</label>
        <textarea autoFocus className="input" value={body} onChange={e => setBody(e.target.value)} rows={8} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} />
        <span className="field-hint">Plain text or JSON. Sent as-is.</span>
      </div>
    </Modal>
  );
}
