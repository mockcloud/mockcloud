import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Card, Empty, Stat, Status, Breadcrumb, Spinner, MiniChart, RowMenu, Modal, SimpleCreateModal, formatBytes, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { TerminalView } from '../components/Terminal.jsx';
import { api } from '../api.js';

function stateKind(s) {
  return { running:'ok', pending:'pending', stopped:'stopped', terminated:'err' }[s] || 'stopped';
}

export function HomePage({ setCurrent, status, setTerminalTarget }) {
  const services = [
    { id:'ec2',      name:'EC2',      icon: Icons.IconEC2,      desc:'Virtual servers',      count: status?.stats?.ec2Total || 0,         unit:'instances' },
    { id:'s3',       name:'S3',       icon: Icons.IconS3,       desc:'Object storage',       count: status?.stats?.s3Buckets || 0,        unit:'buckets' },
    { id:'lambda',   name:'Lambda',   icon: Icons.IconLambda,   desc:'Serverless functions', count: status?.stats?.lambdaFunctions || 0,  unit:'functions' },
    { id:'dynamodb', name:'DynamoDB', icon: Icons.IconDB,       desc:'NoSQL tables',         count: status?.stats?.dynamoTables || 0,     unit:'tables' },
    { id:'sns',      name:'SNS',      icon: Icons.IconSNS,      desc:'Pub/sub topics',       count: status?.stats?.snsTopics || 0,        unit:'topics' },
    { id:'sqs',      name:'SQS',      icon: Icons.IconSQS,      desc:'Message queues',       count: status?.stats?.sqsQueues || 0,        unit:'queues' },
  ];
  const recentActivity = [
    { t:'2m ago', act:'Launched', tgt:'i-0a7f3e', svc:'EC2' },
    { t:'11m ago', act:'Put object', tgt:'logs/app.log', svc:'S3' },
    { t:'34m ago', act:'Invoked', tgt:'resize-image', svc:'Lambda' },
    { t:'1h ago', act:'Created', tgt:'orders-v2', svc:'DynamoDB' },
    { t:'2h ago', act:'Published', tgt:'new-signup', svc:'SNS' },
  ];

  const totalResources = (status?.stats?.ec2Total||0) + (status?.stats?.s3Buckets||0) + (status?.stats?.lambdaFunctions||0) + (status?.stats?.dynamoTables||0) + (status?.stats?.snsTopics||0) + (status?.stats?.sqsQueues||0);

  return (
    <>
      <Breadcrumb items={['Console Home']} />
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <div>
              <h1 className="page-title">Welcome back</h1>
              <p className="page-subtitle">A local-first cloud that mirrors the real thing — for development, testing, and offline hacking.</p>
            </div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconTerminal} onClick={() => { setTerminalTarget({ type:'cli' }); setCurrent('terminal'); }}>Open CLI</Button>
            <Button variant="primary" icon={Icons.IconSparkles}>Start tutorial</Button>
          </div>
        </div>

        <div className="stats-row">
          <Stat label="Resources" value={totalResources} />
          <Stat label="API calls / min" value="128" tint="ok" />
          <Stat label="Simulated latency" value="42" suffix="ms" />
          <Stat label="Daemon uptime" value={status ? `${Math.floor((status.uptime||0)/60)}m` : '—'} />
          <Stat label="Trail events" value={status?.stats?.trailEvents || 0} />
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:16 }}>
          <Card title="Services" count={services.length}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:10 }}>
              {services.map(s => (
                <button key={s.id} onClick={() => setCurrent(s.id)}
                  style={{ textAlign:'left', padding:14, background:'var(--bg-subtle)', border:'1px solid var(--border)', borderRadius:10, transition:'all 160ms', display:'flex', gap:12, alignItems:'flex-start' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor='var(--border-strong)'; e.currentTarget.style.background='var(--bg-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor='var(--border)'; e.currentTarget.style.background='var(--bg-subtle)'; }}
                >
                  <div className="service-icon" style={{ width:32, height:32, borderRadius:8 }}><s.icon size={16} /></div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontWeight:600, fontSize:13.5 }}>{s.name}</div>
                    <div className="muted" style={{ fontSize:12 }}>{s.desc}</div>
                    <div className="mono muted" style={{ fontSize:11.5, marginTop:6 }}>{s.count} {s.unit}</div>
                  </div>
                </button>
              ))}
            </div>
          </Card>

          <Card title="Recent activity">
            <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
              {recentActivity.map((a,i) => (
                <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 0', fontSize:12.5, borderBottom:'1px solid var(--border-subtle)' }}>
                  <span className="mono muted" style={{ width:60 }}>{a.t}</span>
                  <span style={{ fontWeight:500 }}>{a.act}</span>
                  <span className="mono muted" style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis' }}>{a.tgt}</span>
                  <span className="nav-tag">{a.svc}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

