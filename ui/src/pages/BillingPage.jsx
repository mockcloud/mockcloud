import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Card, Empty, Stat, Status, Breadcrumb, Spinner, MiniChart, RowMenu, Modal, SimpleCreateModal, formatBytes, relTime } from '../components/UI.jsx';
import * as Icons from '../components/Icons.jsx';
import { TerminalView } from '../components/Terminal.jsx';
import { api } from '../api.js';

function stateKind(s) {
  return { running:'ok', pending:'pending', stopped:'stopped', terminated:'err' }[s] || 'stopped';
}

export function BillingPage({ pushToast }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setStatus(await api.status()); }
    catch (e) { if(pushToast) pushToast({ kind:'err', title:'Could not refresh', body: e.message }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const ec2Running  = status?.stats?.ec2Running  || 0;
  const lambdaCalls = status?.stats?.lambdaInvocations || 0;
  const s3Gib       = ((status?.stats?.s3Bytes || 0) / 1024 / 1024 / 1024).toFixed(2);
  const s3Buckets   = status?.stats?.s3Buckets || 0;
  const dynamoTbls  = status?.stats?.dynamoTables || 0;
  const snsTopics   = status?.stats?.snsTopics || 0;
  const sqsQueues   = status?.stats?.sqsQueues || 0;

  // Rough real-AWS cost projection (on-demand us-east-1 pricing)
  const ec2Cost    = (ec2Running * 0.0208 * 730).toFixed(2);      // t3.small $0.0208/hr
  const lambdaCost = (Math.max(0, lambdaCalls - 1000000) * 0.0000002).toFixed(4);
  const s3Cost     = (parseFloat(s3Gib) * 0.023).toFixed(4);
  const totalReal  = (parseFloat(ec2Cost) + parseFloat(lambdaCost) + parseFloat(s3Cost) + 0.50).toFixed(2);

  return (
    <>
      <Breadcrumb items={['Console Home','Billing & Cost']}/>
      <div className="page">
        <div className="page-header">
          <div className="page-title-row"><div className="service-icon"><Icons.IconBilling size={20}/></div>
            <div><h1 className="page-title">Billing & Cost</h1><p className="page-subtitle">Local Cloud is free. This page projects what your current usage would cost on real AWS.</p></div>
          </div>
          <div className="page-actions">
            <Button icon={Icons.IconRefresh} onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</Button>
            <Button icon={Icons.IconDownload}>Export invoice</Button>
          </div>
        </div>
        <div className="stats-row">
          <Stat label="Your cost"             value="$0.00"                       tint="ok"/>
          <Stat label="Projected (real AWS)"  value={`$${totalReal}`}/>
          <Stat label="Running instances"     value={ec2Running}/>
          <Stat label="Lambda invocations"    value={lambdaCalls.toLocaleString()}/>
          <Stat label="S3 storage"            value={`${s3Gib} GiB`}/>
        </div>
        <Card title="Cost breakdown" bodyPad={false}>
          <table className="tbl">
            <thead><tr><th>Service</th><th>Usage</th><th>Real AWS cost</th><th style={{textAlign:'right'}}>You pay</th></tr></thead>
            <tbody>
              <tr>
                <td style={{fontWeight:500}}>EC2</td>
                <td className="mono muted">{ec2Running} instance{ec2Running!==1?'s':''} × t3.small × 730h</td>
                <td className="mono muted">${ec2Cost}</td>
                <td className="mono" style={{textAlign:'right',fontWeight:600,color:'var(--ok)'}}>$0.00</td>
              </tr>
              <tr>
                <td style={{fontWeight:500}}>S3</td>
                <td className="mono muted">{s3Gib} GiB · {s3Buckets} bucket{s3Buckets!==1?'s':''}</td>
                <td className="mono muted">${s3Cost}</td>
                <td className="mono" style={{textAlign:'right',fontWeight:600,color:'var(--ok)'}}>$0.00</td>
              </tr>
              <tr>
                <td style={{fontWeight:500}}>Lambda</td>
                <td className="mono muted">{lambdaCalls.toLocaleString()} invocations</td>
                <td className="mono muted">${lambdaCost}</td>
                <td className="mono" style={{textAlign:'right',fontWeight:600,color:'var(--ok)'}}>$0.00</td>
              </tr>
              <tr>
                <td style={{fontWeight:500}}>DynamoDB</td>
                <td className="mono muted">{dynamoTbls} table{dynamoTbls!==1?'s':''}</td>
                <td className="mono muted">~$0.50</td>
                <td className="mono" style={{textAlign:'right',fontWeight:600,color:'var(--ok)'}}>$0.00</td>
              </tr>
              <tr>
                <td style={{fontWeight:500}}>SNS / SQS</td>
                <td className="mono muted">{snsTopics} topic{snsTopics!==1?'s':''}, {sqsQueues} queue{sqsQueues!==1?'s':''}</td>
                <td className="mono muted">~$0.00</td>
                <td className="mono" style={{textAlign:'right',fontWeight:600,color:'var(--ok)'}}>$0.00</td>
              </tr>
              <tr style={{borderTop:'2px solid var(--border)'}}>
                <td colSpan={3} style={{textAlign:'right',fontWeight:600,paddingRight:16}}>Projected total (real AWS)</td>
                <td className="mono" style={{textAlign:'right',fontWeight:700,fontSize:15}}>~${totalReal}</td>
              </tr>
            </tbody>
          </table>
        </Card>
        <div style={{marginTop:16}}>
          <Card title="Savings tips">
            <ul style={{margin:0,paddingLeft:18,fontSize:12.5,lineHeight:1.8,color:'var(--fg-muted)'}}>
              <li>Local Cloud is 100% free — you&apos;re saving <strong style={{color:'var(--fg)'}}>~${totalReal}/month</strong> versus running this on real AWS.</li>
              <li>Stop idle EC2 instances to reduce real-cloud hourly charges when you deploy.</li>
              <li>Lambda is free for the first 1,000,000 requests/month on real AWS.</li>
              <li>Use S3 Intelligent-Tiering for data accessed less than once a month.</li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
