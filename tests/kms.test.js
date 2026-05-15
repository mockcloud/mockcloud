// tests/kms.test.js
// Locks in the regression where KMS Decrypt double-base64-encoded the
// returned Plaintext, breaking Encrypt → Decrypt round-trips for any
// real-world KMS-using app.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { awsJson } from './helpers/http.js';

let server;
const kms = (op, payload) => awsJson(server.endpoint, `TrentService.${op}`, payload);

before(async () => { server = await startServer(); });
after(() => server.close());
beforeEach(() => server.resetStore());

describe('Key management', () => {
  it('CreateKey returns metadata', async () => {
    const res = await kms('CreateKey', { Description: 'unit-test' });
    assert.equal(res.status, 200);
    assert.ok(res.body.KeyMetadata.KeyId);
    assert.equal(res.body.KeyMetadata.Description, 'unit-test');
    assert.equal(res.body.KeyMetadata.KeyState, 'Enabled');
  });

  it('DescribeKey returns the same KeyId', async () => {
    const create = await kms('CreateKey', {});
    const id = create.body.KeyMetadata.KeyId;
    const desc = await kms('DescribeKey', { KeyId: id });
    assert.equal(desc.body.KeyMetadata.KeyId, id);
  });

  it('DescribeKey by ARN resolves correctly', async () => {
    const create = await kms('CreateKey', {});
    const arn = create.body.KeyMetadata.Arn;
    const desc = await kms('DescribeKey', { KeyId: arn });
    assert.equal(desc.status, 200);
  });

  it('ListKeys includes created key', async () => {
    await kms('CreateKey', {});
    await kms('CreateKey', {});
    const list = await kms('ListKeys', {});
    assert.ok(list.body.Keys.length >= 2);
  });

  it('Disable / Enable flips KeyState', async () => {
    const id = (await kms('CreateKey', {})).body.KeyMetadata.KeyId;
    await kms('DisableKey', { KeyId: id });
    let desc = await kms('DescribeKey', { KeyId: id });
    assert.equal(desc.body.KeyMetadata.KeyState, 'Disabled');
    await kms('EnableKey', { KeyId: id });
    desc = await kms('DescribeKey', { KeyId: id });
    assert.equal(desc.body.KeyMetadata.KeyState, 'Enabled');
  });

  it('ScheduleKeyDeletion sets PendingDeletion', async () => {
    const id = (await kms('CreateKey', {})).body.KeyMetadata.KeyId;
    const sched = await kms('ScheduleKeyDeletion', { KeyId: id, PendingWindowInDays: 7 });
    assert.equal(sched.status, 200);
    const desc = await kms('DescribeKey', { KeyId: id });
    assert.equal(desc.body.KeyMetadata.KeyState, 'PendingDeletion');
  });
});

describe('Encrypt / Decrypt round-trip (regression)', () => {
  it('Decrypt returns the same Plaintext that was Encrypted', async () => {
    const id = (await kms('CreateKey', {})).body.KeyMetadata.KeyId;
    // Per AWS contract, Plaintext is base64-encoded on the wire.
    const original = Buffer.from('top secret').toString('base64');
    const enc = await kms('Encrypt', { KeyId: id, Plaintext: original });
    assert.equal(enc.status, 200);
    assert.ok(enc.body.CiphertextBlob);

    const dec = await kms('Decrypt', { CiphertextBlob: enc.body.CiphertextBlob });
    assert.equal(dec.status, 200);
    assert.equal(
      dec.body.Plaintext, original,
      'Decrypt must return the *same* base64 plaintext that was encrypted'
    );
    assert.equal(Buffer.from(dec.body.Plaintext, 'base64').toString(), 'top secret');
  });

  it('Plaintext containing colons does not break parsing', async () => {
    const id = (await kms('CreateKey', {})).body.KeyMetadata.KeyId;
    const original = Buffer.from('a:b:c:d:e').toString('base64');
    const enc = await kms('Encrypt', { KeyId: id, Plaintext: original });
    const dec = await kms('Decrypt', { CiphertextBlob: enc.body.CiphertextBlob });
    assert.equal(dec.body.Plaintext, original);
  });

  it('GenerateDataKey returns both Plaintext and CiphertextBlob', async () => {
    const id = (await kms('CreateKey', {})).body.KeyMetadata.KeyId;
    const dk = await kms('GenerateDataKey', { KeyId: id, KeySpec: 'AES_256' });
    assert.ok(dk.body.Plaintext);
    assert.ok(dk.body.CiphertextBlob);
  });

  it('Decrypt of garbage returns InvalidCiphertextException', async () => {
    const dec = await kms('Decrypt', { CiphertextBlob: Buffer.from('not-our-format').toString('base64') });
    assert.equal(dec.status, 400);
    assert.match(dec.body.__type, /InvalidCiphertextException/);
  });
});
