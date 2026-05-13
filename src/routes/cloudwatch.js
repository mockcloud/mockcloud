// routes/cloudwatch.js — /mockcloud/cloudwatch/* UI API
// Returns REAL metrics from the ring buffer populated by store.putMetric()
import { store } from '../store.js';
import { jsonResponse } from '../middleware/response.js';

export function registerCloudWatchRoutes(app) {

  // All metric namespaces
  app.get('/mockcloud/cloudwatch/namespaces', (req, res) => {
    const namespaces = [...new Set(Object.keys(store.cloudwatch.metrics).map(k => k.split('/')[0]))];
    jsonResponse(res, 200, { namespaces });
  });

  // All metrics (summary — last value per metric)
  app.get('/mockcloud/cloudwatch/metrics', (req, res) => {
    const metrics = Object.entries(store.cloudwatch.metrics).map(([key, points]) => {
      const [namespace, ...rest] = key.split('/');
      const metricName = rest.join('/');
      const last = points[points.length - 1];
      return {
        namespace, metricName,
        lastValue: last?.v ?? 0,
        lastTime:  last?.t ?? null,
        points:    points.length,
        unit:      last?.unit || 'Count',
      };
    });
    jsonResponse(res, 200, { metrics });
  });

  // Time-series data for a specific metric
  app.get('/mockcloud/cloudwatch/metrics/:namespace/:name', (req, res) => {
    const key = `${req.params.namespace}/${req.params.name}`;
    const points = store.cloudwatch.metrics[key] || [];
    const limit  = parseInt(req.query?.limit || '60');
    jsonResponse(res, 200, {
      namespace:  req.params.namespace,
      metricName: req.params.name,
      points:     points.slice(-limit).map(p => ({ t: p.t, v: p.v, unit: p.unit })),
    });
  });

  // Dashboard — pre-built set of key metrics for the WatchPage
  app.get('/mockcloud/cloudwatch/dashboard', (req, res) => {
    const get = (key, limit = 24) => (store.cloudwatch.metrics[key] || []).slice(-limit).map(p => ({ t: p.t, v: p.v }));
    jsonResponse(res, 200, {
      lambdaInvocations: get('MockCloud/Lambda/Invocations'),
      lambdaErrors:      get('MockCloud/Lambda/Errors'),
      s3Objects:         get('MockCloud/S3/NumberOfObjects'),
      s3Bytes:           get('MockCloud/S3/BucketSizeBytes'),
      sqsMessages:       get('MockCloud/SQS/NumberOfMessagesSent'),
      dynamoLatency:     get('MockCloud/DynamoDB/SuccessfulRequestLatency'),
      ec2Running:        get('MockCloud/EC2/RunningInstances'),
      // Live snapshot stats
      live: {
        lambdaFunctions:   Object.keys(store.lambda.functions).length,
        lambdaInvocations: Object.values(store.lambda.functions).reduce((s, f) => s + f.invocations, 0),
        lambdaErrors:      Object.values(store.lambda.functions).reduce((s, f) => s + (f.errors || 0), 0),
        s3Buckets:         Object.keys(store.s3.buckets).length,
        s3Objects:         Object.values(store.s3.buckets).reduce((s, b) => s + Object.keys(b.objects).length, 0),
        sqsQueues:         Object.keys(store.sqs.queues).length,
        sqsMessages:       Object.values(store.sqs.queues).reduce((s, q) => s + q.messages.filter(m => m.visible).length, 0),
        dynamoTables:      Object.keys(store.dynamodb.tables).length,
        ec2Running:        Object.values(store.ec2.instances).filter(i => i.state === 'running').length,
        snsTopics:         Object.keys(store.sns.topics).length,
        ebRules:           Object.values(store.eventbridge.buses).reduce((s, b) => s + Object.keys(b.rules).length, 0),
        kmsKeys:           Object.keys(store.kms.keys).length,
        ssmParams:         Object.keys(store.ssm.parameters).length,
      },
    });
  });

  // Alarms
  app.get('/mockcloud/cloudwatch/alarms', (req, res) => {
    jsonResponse(res, 200, { alarms: Object.values(store.cloudwatch.alarms) });
  });
}
