// tests/s3.test.js
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  PutBucketWebsiteCommand,
  GetBucketWebsiteCommand,
  DeleteBucketWebsiteCommand,
  PutBucketAclCommand,
  GetBucketAclCommand,
  PutPublicAccessBlockCommand,
  GetPublicAccessBlockCommand,
  DeletePublicAccessBlockCommand,
  PutBucketVersioningCommand,
  GetBucketVersioningCommand,
  PutBucketPolicyCommand,
  GetBucketPolicyCommand,
  DeleteBucketPolicyCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, s3;

// Generate a unique bucket name for each test to avoid state bleed from disk hydration
let bucketCounter = 0;
function freshBucket() { return `test-bucket-${Date.now()}-${++bucketCounter}`; }

beforeAll(async () => {
  server = await startServer();
  ({ s3 } = makeClients(server.endpoint));
});

afterAll(() => server.close());
beforeEach(() => server.resetStore());

// ── Bucket basics ────────────────────────────────────────────────────────────

describe('Bucket basics', () => {
  it('CreateBucket succeeds', async () => {
    await assert.doesNotReject(
      () => s3.send(new CreateBucketCommand({ Bucket: freshBucket() }))
    );
  });

  it('HeadBucket returns 200 for existing bucket', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await assert.doesNotReject(() => s3.send(new HeadBucketCommand({ Bucket: bucket })));
  });

  it('HeadBucket throws for missing bucket', async () => {
    await assert.rejects(
      () => s3.send(new HeadBucketCommand({ Bucket: 'no-such-bucket-xyz' })),
      err => {
        assert.equal(err.$metadata.httpStatusCode, 404);
        return true;
      }
    );
  });
});

// ── Object operations ────────────────────────────────────────────────────────

describe('Object operations', () => {
  it('PutObject and GetObject round-trip', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const body = Buffer.from('hello mockcloud');
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'hello.txt', Body: body }));
    const get = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'hello.txt' }));
    const chunks = [];
    for await (const chunk of get.Body) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'hello mockcloud');
  });

  it('ListObjectsV2 returns uploaded objects', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'a.txt', Body: Buffer.from('a') }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'b.txt', Body: Buffer.from('b') }));
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    assert.equal(list.KeyCount, 2);
    const keys = list.Contents.map(o => o.Key);
    assert.ok(keys.includes('a.txt'));
    assert.ok(keys.includes('b.txt'));
  });
});

// ── Website configuration ────────────────────────────────────────────────────

describe('Bucket website configuration', () => {
  it('PutBucketWebsite and GetBucketWebsite round-trip', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutBucketWebsiteCommand({
      Bucket: bucket,
      WebsiteConfiguration: {
        IndexDocument: { Suffix: 'index.html' },
        ErrorDocument: { Key: '404.html' },
      },
    }));
    const get = await s3.send(new GetBucketWebsiteCommand({ Bucket: bucket }));
    assert.equal(get.IndexDocument.Suffix, 'index.html');
    assert.equal(get.ErrorDocument.Key, '404.html');
  });

  it('DeleteBucketWebsite removes config', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutBucketWebsiteCommand({
      Bucket: bucket,
      WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' } },
    }));
    await s3.send(new DeleteBucketWebsiteCommand({ Bucket: bucket }));
    await assert.rejects(
      () => s3.send(new GetBucketWebsiteCommand({ Bucket: bucket })),
      err => { assert.ok(err.$metadata.httpStatusCode >= 400); return true; }
    );
  });
});

// ── ACL ──────────────────────────────────────────────────────────────────────

describe('Bucket ACL', () => {
  it('PutBucketAcl succeeds with canned ACL', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await assert.doesNotReject(() =>
      s3.send(new PutBucketAclCommand({ Bucket: bucket, ACL: 'public-read' }))
    );
  });

  it('GetBucketAcl returns owner info', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const res = await s3.send(new GetBucketAclCommand({ Bucket: bucket }));
    assert.ok(res.Owner, 'should return Owner');
    assert.ok(res.Grants?.length >= 1, 'should return at least one Grant');
  });
});

// ── Public access block ──────────────────────────────────────────────────────

describe('Public access block', () => {
  it('PutPublicAccessBlock and GetPublicAccessBlock round-trip', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    }));
    const get = await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
    const cfg = get.PublicAccessBlockConfiguration;
    assert.equal(cfg.BlockPublicAcls, true);
    assert.equal(cfg.IgnorePublicAcls, true);
    assert.equal(cfg.BlockPublicPolicy, false);
    assert.equal(cfg.RestrictPublicBuckets, false);
  });

  it('DeletePublicAccessBlock removes config', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: { BlockPublicAcls: true },
    }));
    await s3.send(new DeletePublicAccessBlockCommand({ Bucket: bucket }));
    await assert.rejects(
      () => s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket })),
      err => { assert.ok(err.$metadata.httpStatusCode >= 400); return true; }
    );
  });
});

// ── Versioning ───────────────────────────────────────────────────────────────

describe('Bucket versioning', () => {
  it('PutBucketVersioning enables versioning', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }));
    const get = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    assert.equal(get.Status, 'Enabled');
  });

  it('PutBucketVersioning can suspend versioning', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: 'Suspended' },
    }));
    const get = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    assert.equal(get.Status, 'Suspended');
  });
});

// ── Bucket policy ─────────────────────────────────────────────────────────────

describe('Bucket policy', () => {
  it('PutBucketPolicy and GetBucketPolicy round-trip', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${bucket}/*`,
      }],
    });
    await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: policy }));
    const get = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    const parsed = JSON.parse(get.Policy);
    assert.equal(parsed.Statement[0].Effect, 'Allow');
  });

  it('GetBucketPolicy throws 404 if no policy set', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await assert.rejects(
      () => s3.send(new GetBucketPolicyCommand({ Bucket: bucket })),
      err => { assert.equal(err.$metadata.httpStatusCode, 404); return true; }
    );
  });

  it('DeleteBucketPolicy removes policy', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const policy = JSON.stringify({ Version: '2012-10-17', Statement: [] });
    await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: policy }));
    await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    await assert.rejects(
      () => s3.send(new GetBucketPolicyCommand({ Bucket: bucket })),
      err => { assert.equal(err.$metadata.httpStatusCode, 404); return true; }
    );
  });
});
