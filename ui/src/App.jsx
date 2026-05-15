// App.jsx — root component
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Topbar, Sidebar } from './components/Shell.jsx';
import { CloudTrail, CmdK, Toasts } from './components/UI.jsx';
import {
  HomePage, EC2Page, S3Page, LambdaPage, DynamoPage,
  SNSPage, SQSPage, SecretsPage, IAMPage,
  WatchPage, TrailPage, BillingPage, TerminalPage,
  KMSPage, SSMPage, EventBridgePage, SESPage,
  StepFunctionsPage, CognitoPage,
} from './pages/index.js';
import { api } from './api.js';

let toastId = 0;

export default function App() {
  const [theme, setTheme]               = useState(() => localStorage.getItem('mc-theme') || localStorage.getItem('lc-theme') || 'dark');
  const [page, setPage]                 = useState('home');
  const [terminalTarget, setTerminalTarget] = useState(null);
  const [cmdOpen, setCmdOpen]           = useState(false);
  const [trail, setTrail]               = useState([]);
  const [status, setStatus]             = useState(null);
  const [toasts, setToasts]             = useState([]);
  const trailTimer                      = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('mc-theme', theme);
  }, [theme]);

  const fetchTrail  = useCallback(async () => { try { const d = await api.trail(); setTrail(d.events || []); } catch {} }, []);
  const fetchStatus = useCallback(async () => { try { setStatus(await api.status()); } catch {} }, []);

  useEffect(() => {
    fetchTrail(); fetchStatus();
    trailTimer.current = setInterval(fetchTrail, 3000);
    const st = setInterval(fetchStatus, 10000);
    return () => { clearInterval(trailTimer.current); clearInterval(st); };
  }, [fetchTrail, fetchStatus]);

  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmdOpen(true); }
      if (e.key === 'Escape') setCmdOpen(false);
      if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        if (e.key === 'h') setPage('home');
        if (e.key === 'e') setPage('ec2');
        if (e.key === 's') setPage('s3');
        if (e.key === 'l') setPage('lambda');
        if (e.key === 'd') setPage('dynamodb');
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const pushToast = useCallback(({ kind, title, body }) => {
    const id = ++toastId;
    setToasts(t => [...t, { id, kind, title, body }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
  }, []);

  const clearTrail = useCallback(async () => { try { await api.clearTrail(); setTrail([]); } catch {} }, []);

  const counts = {
    ec2:         status?.stats?.ec2Total        || undefined,
    s3:          status?.stats?.s3Buckets       || undefined,
    lambda:      status?.stats?.lambdaFunctions || undefined,
    dynamodb:    status?.stats?.dynamoTables    || undefined,
    sns:         status?.stats?.snsTopics       || undefined,
    sqs:         status?.stats?.sqsQueues       || undefined,
    eventbridge: status?.stats?.ebRules         || undefined,
    secrets:     status?.stats?.secrets         || undefined,
    kms:         status?.stats?.kmsKeys         || undefined,
    ssm:         status?.stats?.ssmParameters   || undefined,
    ses:         status?.stats?.sesEmails       || undefined,
    sfn:         status?.stats?.sfnMachines     || undefined,
    cognito:     status?.stats?.cognitoPools    || undefined,
    watch:       status?.stats?.cwMetrics       || undefined,
    trail:       trail.length                   || undefined,
  };

  function renderPage() {
    const p = { pushToast, status };
    switch (page) {
      case 'home':        return <HomePage {...p} setCurrent={setPage} setTerminalTarget={setTerminalTarget} />;
      case 'ec2':         return <EC2Page {...p} setCurrent={setPage} setTerminalTarget={setTerminalTarget} />;
      case 's3':          return <S3Page {...p} />;
      case 'lambda':      return <LambdaPage {...p} />;
      case 'dynamodb':    return <DynamoPage {...p} />;
      case 'sns':         return <SNSPage {...p} />;
      case 'sqs':         return <SQSPage {...p} />;
      case 'secrets':     return <SecretsPage {...p} />;
      case 'iam':         return <IAMPage {...p} />;
      case 'watch':       return <WatchPage {...p} />;
      case 'trail':       return <TrailPage events={trail} />;
      case 'billing':     return <BillingPage pushToast={pushToast} />;
      case 'terminal':    return <TerminalPage target={terminalTarget} pushToast={pushToast} onBack={() => setPage(terminalTarget?.type === 'ec2' ? 'ec2' : 'home')} />;
      case 'kms':         return <KMSPage {...p} />;
      case 'ssm':         return <SSMPage {...p} />;
      case 'eventbridge': return <EventBridgePage {...p} />;
      case 'ses':         return <SESPage {...p} />;
      case 'sfn':         return <StepFunctionsPage {...p} />;
      case 'cognito':     return <CognitoPage {...p} />;
      default:            return <HomePage {...p} setCurrent={setPage} setTerminalTarget={setTerminalTarget} />;
    }
  }

  return (
    <div className="app">
      <Topbar theme={theme} setTheme={setTheme} openCmd={() => setCmdOpen(true)} version={status?.version} pushToast={pushToast} />
      <Sidebar current={page} setCurrent={id => {
        if (id === 'terminal' && (!terminalTarget || terminalTarget.type === 'ec2')) setTerminalTarget({ type: 'cli' });
        setPage(id);
      }} counts={counts} />
      <main className="main">{renderPage()}</main>
      <CloudTrail events={trail} onClear={clearTrail} />
      <CmdK open={cmdOpen} onClose={() => setCmdOpen(false)} onNavigate={setPage} />
      <Toasts toasts={toasts} />
    </div>
  );
}
