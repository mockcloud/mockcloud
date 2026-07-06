// tests/s3-dataplane.test.js — CopyObject, Range GET, conditional requests,
// DeleteObjects, and virtual-hosted-style addressing.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  CreateBucketCommand, PutObjectCommand, GetObjectCommand, CopyObjectCommand,
  DeleteObjectsCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, s3, n = 0;
const freshBucket = () => `dp-bucket-${Date.now()}-${++n}`;
beforeAll(async () => { server = await startServer(); ({ s3 } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

const body = async get => { const c = []; for await (const x of get.Body) c.push(x); return Buffer.concat(c).toString(); };
// Raw GET with full header control (undici can override fetch's Host header).
function rawGet(endpoint, path, headers) {
  const u = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method: 'GET', headers }, res => {
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
}

describe('S3 data-plane', () => {
  it('CopyObject duplicates an object', async () => {
    const b = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: b }));
    await s3.send(new PutObjectCommand({ Bucket: b, Key: 'src.txt', Body: 'original' }));
    await s3.send(new CopyObjectCommand({ Bucket: b, Key: 'dst.txt', CopySource: `/${b}/src.txt` }));
    assert.equal(await body(await s3.send(new GetObjectCommand({ Bucket: b, Key: 'dst.txt' }))), 'original');
  });

  it('Range GET returns 206 partial content', async () => {
    const b = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: b }));
    await s3.send(new PutObjectCommand({ Bucket: b, Key: 'r.txt', Body: '0123456789' }));
    const got = await s3.send(new GetObjectCommand({ Bucket: b, Key: 'r.txt', Range: 'bytes=2-5' }));
    assert.equal(got.ContentRange, 'bytes 2-5/10');
    assert.equal(await body(got), '2345');
  });

  it('conditional If-None-Match yields 304', async () => {
    const b = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: b }));
    const put = await s3.send(new PutObjectCommand({ Bucket: b, Key: 'c.txt', Body: 'x' }));
    await assert.rejects(
      () => s3.send(new GetObjectCommand({ Bucket: b, Key: 'c.txt', IfNoneMatch: put.ETag })),
      err => { assert.equal(err.$metadata.httpStatusCode, 304); return true; }
    );
  });

  it('DeleteObjects removes many keys at once', async () => {
    const b = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: b }));
    for (const k of ['a', 'b', 'c']) await s3.send(new PutObjectCommand({ Bucket: b, Key: k, Body: k }));
    const del = await s3.send(new DeleteObjectsCommand({ Bucket: b, Delete: { Objects: [{ Key: 'a' }, { Key: 'b' }, { Key: 'c' }] } }));
    assert.equal(del.Deleted.length, 3);
    const list = await s3.send(new ListObjectsV2Command({ Bucket: b }));
    assert.ok(!list.Contents || list.Contents.length === 0);
  });

  it('stores and returns uploaded bytes verbatim (no content-encoding mangling)', async () => {
    // Purpose: catches any server implementation that mishandles request
    // framing (aws-chunked, checksum trailers) by storing framed bytes — the
    // ETag can lie if both sides hash the same mangled bytes, byte-equality
    // cannot. >8KB nonuniform payload so it isn't trivially compressible and
    // spans multiple stream chunks.
    const b = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: b }));
    const uploaded = Buffer.alloc(32 * 1024);
    for (let i = 0; i < uploaded.length; i++) uploaded[i] = (i * 31 + 7) % 256;
    await s3.send(new PutObjectCommand({ Bucket: b, Key: 'verbatim.bin', Body: uploaded }));
    const got = await s3.send(new GetObjectCommand({ Bucket: b, Key: 'verbatim.bin' }));
    assert.equal(got.ContentLength, uploaded.length);
    const chunks = []; for await (const x of got.Body) chunks.push(x);
    const downloaded = Buffer.concat(chunks);
    assert.equal(downloaded.length, uploaded.length);
    assert.equal(Buffer.compare(downloaded, uploaded), 0);
  });

  it('virtual-hosted-style addressing resolves the bucket from Host', async () => {
    const b = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: b }));
    await s3.send(new PutObjectCommand({ Bucket: b, Key: 'vh.txt', Body: 'vhost' }));
    const res = await rawGet(server.endpoint, '/vh.txt', { Host: `${b}.s3.amazonaws.com` });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'vhost');
  });
});
