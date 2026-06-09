// tests/cloudwatch.test.js — CloudWatch metrics via @aws-sdk/client-cloudwatch.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { PutMetricDataCommand, GetMetricStatisticsCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, cw;
beforeAll(async () => { server = await startServer(); ({ cw } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

describe('CloudWatch metrics', () => {
  it('PutMetricData then GetMetricStatistics aggregates the datapoints', async () => {
    const now = new Date();
    await cw.send(new PutMetricDataCommand({
      Namespace: 'MyApp',
      MetricData: [
        { MetricName: 'Latency', Value: 100, Unit: 'Milliseconds', Timestamp: now },
        { MetricName: 'Latency', Value: 200, Unit: 'Milliseconds', Timestamp: now },
      ],
    }));
    const stats = await cw.send(new GetMetricStatisticsCommand({
      Namespace: 'MyApp', MetricName: 'Latency',
      StartTime: new Date(now.getTime() - 60_000), EndTime: new Date(now.getTime() + 60_000),
      Period: 300, Statistics: ['Sum', 'Average', 'Maximum', 'SampleCount'],
    }));
    assert.equal(stats.Datapoints.length, 1);
    const dp = stats.Datapoints[0];
    assert.equal(dp.Sum, 300);
    assert.equal(dp.Average, 150);
    assert.equal(dp.Maximum, 200);
    assert.equal(dp.SampleCount, 2);
  });

  it('ListMetrics includes a custom namespace/metric', async () => {
    await cw.send(new PutMetricDataCommand({ Namespace: 'MyApp', MetricData: [{ MetricName: 'Hits', Value: 1 }] }));
    const { Metrics } = await cw.send(new ListMetricsCommand({ Namespace: 'MyApp' }));
    assert.ok(Metrics.some(m => m.MetricName === 'Hits' && m.Namespace === 'MyApp'));
  });
});
