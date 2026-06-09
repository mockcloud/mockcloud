// tests/store.test.js
// Direct unit tests for store.js — covers the snapshot-import regression
// (shallow merge used to leak prior state) and the reset behaviour.

import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { store } from '../src/store.js';

beforeEach(() => store.reset());

describe('store.reset', () => {
  it('reset() restores all services to their factory defaults', () => {
    store.s3.buckets['x'] = { name: 'x', objects: {} };
    store.sqs.queues['u'] = { name: 'q', messages: [] };
    store.reset();
    assert.deepEqual(store.s3.buckets, {});
    assert.deepEqual(store.sqs.queues, {});
  });

  it('reset(service) restores only that service and preserves config defaults', () => {
    store.ec2.instances['i-1'] = { id: 'i-1', state: 'running' };
    store.s3.buckets['keep'] = { name: 'keep', objects: {} };

    store.reset('ec2');

    assert.deepEqual(store.ec2.instances, {});
    // other services untouched
    assert.ok(store.s3.buckets['keep']);
  });

  it('cloudwatch.maxPoints survives reset', () => {
    store.cloudwatch.maxPoints = 10;
    store.reset('cloudwatch');
    assert.equal(store.cloudwatch.maxPoints, 1440);
  });

  it('eventbridge default bus survives reset', () => {
    delete store.eventbridge.buses.default;
    store.reset('eventbridge');
    assert.ok(store.eventbridge.buses.default);
    assert.equal(store.eventbridge.buses.default.name, 'default');
  });
});

describe('store.import (regression: shallow-merge used to leak prior state)', () => {
  it('importing a snapshot replaces a service namespace, not merges into it', () => {
    // Pre-existing instance — should NOT survive import of a snapshot whose
    // ec2 namespace contains a different set of instances.
    store.ec2.instances['leftover'] = { id: 'leftover', state: 'running' };

    const snapshot = {
      version: 1,
      ec2: { instances: { 'i-new': { id: 'i-new', state: 'running' } }, keyPairs: {}, securityGroups: {} },
    };
    store.import(snapshot);

    assert.equal(store.ec2.instances['leftover'], undefined,
      'pre-import state must be cleared when the service is in the snapshot');
    assert.ok(store.ec2.instances['i-new']);
  });

  it('services missing from the snapshot keep their current state', () => {
    store.s3.buckets['keep'] = { name: 'keep', objects: {} };
    store.import({ version: 1, sqs: { queues: {} } });
    assert.ok(store.s3.buckets['keep']);
  });

  it('round-trip: export → import preserves data', () => {
    store.s3.buckets['rt'] = { name: 'rt', objects: { 'k': { key: 'k', size: 5 } } };
    const snap = store.export();
    store.reset();
    store.import(snap);
    assert.ok(store.s3.buckets['rt']);
    assert.equal(store.s3.buckets['rt'].objects['k'].size, 5);
  });
});

describe('store.export', () => {
  it('emits valid JSON containing all registered services', () => {
    const snap = JSON.parse(store.export());
    for (const k of ['s3', 'dynamodb', 'lambda', 'iam', 'sns', 'sqs', 'ec2', 'eventbridge', 'cloudwatch']) {
      assert.ok(k in snap, `snapshot should include service "${k}"`);
    }
  });

  it('trims lambda function logs to 20 entries', () => {
    store.lambda.functions['noisy'] = {
      name: 'noisy', invocations: 0, errors: 0, env: {}, code: '',
      logs: Array.from({ length: 100 }, (_, i) => ({ t: i, level: 'INFO', msg: `log ${i}` })),
    };
    const snap = JSON.parse(store.export());
    assert.equal(snap.lambda.functions['noisy'].logs.length, 20);
  });
});

describe('store.putMetric ring buffer', () => {
  it('keeps at most maxPoints samples per metric', () => {
    store.cloudwatch.maxPoints = 3;
    for (let i = 0; i < 10; i++) store.putMetric('TestNS', 'X', i);
    const samples = store.cloudwatch.metrics['TestNS/X'];
    assert.equal(samples.length, 3);
    // most recent values are kept (oldest are shifted off the front)
    assert.deepEqual(samples.map(s => s.v), [7, 8, 9]);
  });
});
