// tests/ssm.test.js — SSM Parameter Store

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { awsJson } from './helpers/http.js';

let server;
const ssm = (op, payload) => awsJson(server.endpoint, `AmazonSSM.${op}`, payload);

before(async () => { server = await startServer(); });
after(() => server.close());
beforeEach(() => server.resetStore());

describe('PutParameter / GetParameter', () => {
  it('PutParameter creates a v1 parameter', async () => {
    const res = await ssm('PutParameter', { Name: '/app/db', Value: 'prod', Type: 'String' });
    assert.equal(res.status, 200);
    assert.equal(res.body.Version, 1);
  });

  it('PutParameter without Overwrite rejects existing name', async () => {
    await ssm('PutParameter', { Name: '/dup', Value: '1', Type: 'String' });
    const dup = await ssm('PutParameter', { Name: '/dup', Value: '2', Type: 'String' });
    assert.equal(dup.status, 400);
    assert.match(dup.body.__type, /ParameterAlreadyExists/);
  });

  it('PutParameter Overwrite=true bumps version', async () => {
    await ssm('PutParameter', { Name: '/v', Value: '1', Type: 'String' });
    const r2 = await ssm('PutParameter', { Name: '/v', Value: '2', Type: 'String', Overwrite: true });
    assert.equal(r2.body.Version, 2);
  });

  it('GetParameter returns current value', async () => {
    await ssm('PutParameter', { Name: '/g', Value: 'v1', Type: 'String' });
    const get = await ssm('GetParameter', { Name: '/g' });
    assert.equal(get.status, 200);
    assert.equal(get.body.Parameter.Value, 'v1');
    assert.equal(get.body.Parameter.Version, 1);
    // history is internal — must not leak through GetParameter
    assert.equal(get.body.Parameter.history, undefined);
  });

  it('GetParameter on missing 400s', async () => {
    const res = await ssm('GetParameter', { Name: '/nope' });
    assert.equal(res.status, 400);
    assert.match(res.body.__type, /ParameterNotFound/);
  });
});

describe('GetParameters / DeleteParameter', () => {
  beforeEach(async () => {
    await ssm('PutParameter', { Name: '/a', Value: '1', Type: 'String' });
    await ssm('PutParameter', { Name: '/b', Value: '2', Type: 'String' });
  });

  it('GetParameters splits found and missing', async () => {
    const res = await ssm('GetParameters', { Names: ['/a', '/b', '/missing'] });
    assert.equal(res.body.Parameters.length, 2);
    assert.deepEqual(res.body.InvalidParameters, ['/missing']);
  });

  it('DeleteParameter removes it', async () => {
    await ssm('DeleteParameter', { Name: '/a' });
    const get = await ssm('GetParameter', { Name: '/a' });
    assert.equal(get.status, 400);
  });

  it('DeleteParameters reports deleted vs invalid', async () => {
    const res = await ssm('DeleteParameters', { Names: ['/a', '/b', '/x'] });
    assert.deepEqual(res.body.DeletedParameters.sort(), ['/a', '/b']);
    assert.deepEqual(res.body.InvalidParameters, ['/x']);
  });
});

describe('Parameter history', () => {
  it('GetParameterHistory returns each version', async () => {
    await ssm('PutParameter', { Name: '/h', Value: 'v1', Type: 'String' });
    await ssm('PutParameter', { Name: '/h', Value: 'v2', Type: 'String', Overwrite: true });
    await ssm('PutParameter', { Name: '/h', Value: 'v3', Type: 'String', Overwrite: true });
    const hist = await ssm('GetParameterHistory', { Name: '/h' });
    assert.equal(hist.body.Parameters.length, 3);
    assert.deepEqual(hist.body.Parameters.map(p => p.Value), ['v1', 'v2', 'v3']);
  });
});
