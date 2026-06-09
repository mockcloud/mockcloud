// tests/sigv4.test.js
// Opt-in SigV4 verification (MOCKCLOUD_VERIFY_SIGV4=true). This file flips the
// flag for its own process (vitest `forks` pool isolates it), so other suites
// keep running unsigned. Covers header auth (good / wrong-secret / unknown-key
// / unsigned) and presigned URLs (good / tampered).
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';

process.env.MOCKCLOUD_VERIFY_SIGV4 = 'true';   // MUST be set before startServer

const { startServer } = await import('./helpers/server.js');
const { awsJson } = await import('./helpers/http.js');
const { SQSClient, CreateQueueCommand } = await import('@aws-sdk/client-sqs');
const { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

let server;
beforeAll(async () => { server = await startServer(); });
afterAll(() => { server.close(); delete process.env.MOCKCLOUD_VERIFY_SIGV4; });
beforeEach(() => server.resetStore());

const sqsWith = (accessKeyId, secretAccessKey) =>
  new SQSClient({ endpoint: server.endpoint, region: 'us-east-1', credentials: { accessKeyId, secretAccessKey } });
const s3With = (accessKeyId, secretAccessKey) =>
  new S3Client({ endpoint: server.endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });

async function expectError(promise) {
  try { await promise; return null; }
  catch (e) { return e; }
}

describe('SigV4 header auth', () => {
  it('accepts a request signed with the seeded credential', async () => {
    const sqs = sqsWith('test', 'test');
    const out = await sqs.send(new CreateQueueCommand({ QueueName: 'signed-ok' }));
    assert.ok(out.QueueUrl, 'correctly-signed request should succeed');
  });

  it('rejects a wrong secret with SignatureDoesNotMatch', async () => {
    const sqs = sqsWith('test', 'not-the-secret');
    const err = await expectError(sqs.send(new CreateQueueCommand({ QueueName: 'bad-sig' })));
    assert.ok(err, 'should reject');
    assert.equal(err.$metadata?.httpStatusCode, 403);
    assert.match(err.name, /SignatureDoesNotMatch/);
  });

  it('rejects an unknown access key with InvalidAccessKeyId', async () => {
    const sqs = sqsWith('AKIAGHOSTKEYDOESNOTEXIST', 'whatever');
    const err = await expectError(sqs.send(new CreateQueueCommand({ QueueName: 'ghost' })));
    assert.ok(err, 'should reject');
    assert.equal(err.$metadata?.httpStatusCode, 403);
    assert.match(err.name, /InvalidAccessKeyId/);
  });

  it('rejects an unsigned request', async () => {
    // awsJson sends no Authorization header.
    const res = await awsJson(server.endpoint, 'AmazonSQS.ListQueues', {});
    assert.equal(res.status, 403);
    assert.equal(res.body.__type, 'MissingAuthenticationToken');
  });

  it('accepts a credential added via CreateAccessKey', async () => {
    // Seed a new key through the IAM API (signed with the bootstrap creds),
    // then use it to sign a fresh request.
    const iam = await awsForm('CreateUser', { UserName: 'alice' });
    void iam;
    const created = await awsForm('CreateAccessKey', { UserName: 'alice' });
    const akid = xmlValue(created.body, 'AccessKeyId');
    const secret = xmlValue(created.body, 'SecretAccessKey');
    assert.ok(akid && secret);
    const sqs = sqsWith(akid, secret);
    const out = await sqs.send(new CreateQueueCommand({ QueueName: 'via-new-key' }));
    assert.ok(out.QueueUrl);
  });
});

describe('SigV4 presigned URLs', () => {
  it('accepts a valid presigned GET and rejects a tampered one', async () => {
    const s3 = s3With('test', 'test');
    await s3.send(new CreateBucketCommand({ Bucket: 'presign-b' }));
    await s3.send(new PutObjectCommand({ Bucket: 'presign-b', Key: 'k.txt', Body: 'hello' }));

    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: 'presign-b', Key: 'k.txt' }), { expiresIn: 3600 });
    const ok = await fetch(url);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'hello');

    // Flip the last hex char of the signature → must fail verification.
    const tampered = url.replace(/(X-Amz-Signature=[0-9a-f]*)([0-9a-f])/, (_, p, last) => p + (last === '0' ? '1' : '0'));
    const bad = await fetch(tampered);
    assert.equal(bad.status, 403);
    assert.match(await bad.text(), /SignatureDoesNotMatch/);
  });
});

// IAM uses the (signed) query protocol and no IAM SDK client is installed, so
// sign the request manually with the same SignatureV4 the SDKs use internally.
async function awsForm(action, params) {
  const { SignatureV4 } = await import('@smithy/signature-v4');
  const { Sha256 } = await import('@aws-crypto/sha256-js');
  const body = new URLSearchParams({ Action: action, Version: '2010-05-08', ...params }).toString();
  const u = new URL(server.endpoint + '/');
  const signer = new SignatureV4({
    service: 'iam', region: 'us-east-1', sha256: Sha256,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const signed = await signer.sign({
    method: 'POST', protocol: 'http:', hostname: u.hostname, port: Number(u.port), path: '/',
    headers: { host: u.host, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const res = await fetch(server.endpoint + '/', { method: 'POST', headers: signed.headers, body });
  return { status: res.status, body: await res.text() };
}

function xmlValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1] : null;
}
