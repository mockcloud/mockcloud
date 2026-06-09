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
  DeleteObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

  it('paginates ListObjectsV2 with ContinuationToken', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    for (const k of ['a', 'b', 'c']) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: k, Body: Buffer.from(k) }));
    const p1 = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 2 }));
    assert.equal(p1.KeyCount, 2);
    assert.equal(p1.IsTruncated, true);
    assert.ok(p1.NextContinuationToken);
    assert.deepEqual(p1.Contents.map(o => o.Key), ['a', 'b']);
    const p2 = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 2, ContinuationToken: p1.NextContinuationToken }));
    assert.equal(p2.IsTruncated, false);
    assert.deepEqual(p2.Contents.map(o => o.Key), ['c']);
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

// ── Presigned URLs (real SigV4 query-param signing) ────────────────────────────

describe('Presigned URLs', () => {
  it('presigned GET fetches the object body', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'hello.txt', Body: Buffer.from('presigned-body') }));

    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: 'hello.txt' }), { expiresIn: 60 });
    assert.match(url, /X-Amz-Signature=/);
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'presigned-body');
  });

  it('presigned PUT uploads an object that reads back via the SDK', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: 'up.txt' }), { expiresIn: 60 });
    const put = await fetch(url, { method: 'PUT', body: 'uploaded-via-presign' });
    assert.equal(put.status, 200);

    const get = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'up.txt' }));
    const chunks = [];
    for await (const chunk of get.Body) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'uploaded-via-presign');
  });

  it('an expired presigned URL is rejected with 403', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'k.txt', Body: Buffer.from('x') }));

    const u = new URL(await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: 'k.txt' }), { expiresIn: 60 }));
    // Rewind the signing time well past the 60s window — MockCloud ignores the
    // (now-invalid) signature but enforces X-Amz-Date + X-Amz-Expires.
    u.searchParams.set('X-Amz-Date', '20200101T000000Z');
    const res = await fetch(u);
    assert.equal(res.status, 403);
  });

  it('rejects a presigned URL missing the signature', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'k.txt', Body: Buffer.from('x') }));
    const u = new URL(await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: 'k.txt' }), { expiresIn: 60 }));
    u.searchParams.delete('X-Amz-Signature');
    const res = await fetch(u);
    assert.equal(res.status, 403);
  });
});

// ── Object versioning ──────────────────────────────────────────────────────────

describe('Object versioning', () => {
  async function readBody(get) {
    const chunks = [];
    for await (const c of get.Body) chunks.push(c);
    return Buffer.concat(chunks).toString();
  }
  async function enableVersioning(bucket) {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
  }

  it('PutObject returns distinct VersionIds and keeps every version', async () => {
    const bucket = freshBucket();
    await enableVersioning(bucket);
    const v1 = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'doc', Body: Buffer.from('one') }));
    const v2 = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'doc', Body: Buffer.from('two') }));
    assert.ok(v1.VersionId);
    assert.ok(v2.VersionId);
    assert.notEqual(v1.VersionId, v2.VersionId);

    assert.equal(await readBody(await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'doc' }))), 'two');
    assert.equal(await readBody(await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'doc', VersionId: v1.VersionId }))), 'one');
  });

  it('ListObjectVersions reports all versions with IsLatest', async () => {
    const bucket = freshBucket();
    await enableVersioning(bucket);
    const v1 = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'k', Body: Buffer.from('a') }));
    const v2 = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'k', Body: Buffer.from('bb') }));

    const list = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
    assert.equal(list.Versions.length, 2);
    assert.equal(list.Versions.find(v => v.IsLatest).VersionId, v2.VersionId);
    assert.equal(list.Versions.find(v => v.VersionId === v1.VersionId).IsLatest, false);
  });

  it('DeleteObject inserts a delete marker; the key 404s but old versions remain', async () => {
    const bucket = freshBucket();
    await enableVersioning(bucket);
    const v1 = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'k', Body: Buffer.from('live') }));

    const del = await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: 'k' }));
    assert.equal(del.DeleteMarker, true);
    assert.ok(del.VersionId);

    await assert.rejects(
      () => s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'k' })),
      err => { assert.equal(err.$metadata.httpStatusCode, 404); return true; }
    );
    assert.equal(await readBody(await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'k', VersionId: v1.VersionId }))), 'live');

    const list = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
    assert.equal(list.DeleteMarkers.length, 1);
    assert.equal(list.Versions.length, 1);

    const v2list = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    assert.ok(!(v2list.Contents || []).some(o => o.Key === 'k'));
  });

  it('DeleteObject with a VersionId permanently removes that version', async () => {
    const bucket = freshBucket();
    await enableVersioning(bucket);
    const v1 = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'k', Body: Buffer.from('one') }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'k', Body: Buffer.from('two') }));

    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: 'k', VersionId: v1.VersionId }));
    await assert.rejects(
      () => s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'k', VersionId: v1.VersionId })),
      err => { assert.equal(err.$metadata.httpStatusCode, 404); return true; }
    );
    assert.equal(await readBody(await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'k' }))), 'two');
    const list = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
    assert.equal(list.Versions.length, 1);
  });
});

// ── CORS ───────────────────────────────────────────────────────────────────────

describe('Bucket CORS', () => {
  const corsConfig = {
    CORSRules: [{
      AllowedOrigins: ['https://app.example.com'],
      AllowedMethods: ['GET', 'PUT'],
      AllowedHeaders: ['*'],
      ExposeHeaders:  ['ETag'],
      MaxAgeSeconds:  3000,
    }],
  };

  it('PutBucketCors and GetBucketCors round-trip', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: corsConfig }));
    const got = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
    assert.equal(got.CORSRules.length, 1);
    assert.deepEqual(got.CORSRules[0].AllowedOrigins, ['https://app.example.com']);
    assert.deepEqual([...got.CORSRules[0].AllowedMethods].sort(), ['GET', 'PUT']);
  });

  it('allows a preflight from a permitted origin', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: corsConfig }));
    const res = await fetch(`${server.endpoint}/${bucket}`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
    assert.ok(res.headers.get('access-control-allow-methods').includes('GET'));
  });

  it('rejects a preflight from a disallowed origin with 403', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: corsConfig }));
    const res = await fetch(`${server.endpoint}/${bucket}`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(res.status, 403);
  });
});
