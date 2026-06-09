// tests/s3-multipart.test.js — multipart upload via @aws-sdk/client-s3.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CreateBucketCommand, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListPartsCommand,
  ListMultipartUploadsCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, s3, n = 0;
const freshBucket = () => `mpu-${Date.now()}-${++n}`;
beforeAll(async () => { server = await startServer(); ({ s3 } = makeClients(server.endpoint)); });
afterAll(() => server.close());
beforeEach(() => server.resetStore());

async function readBody(get) { const c = []; for await (const x of get.Body) c.push(x); return Buffer.concat(c); }

describe('S3 multipart upload', () => {
  it('uploads parts and completes into one object (binary-exact)', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: 'big.bin' }));
    const part1 = Buffer.alloc(1024, 0x41), part2 = Buffer.alloc(512, 0x42);
    const u1 = await s3.send(new UploadPartCommand({ Bucket: bucket, Key: 'big.bin', UploadId, PartNumber: 1, Body: part1 }));
    const u2 = await s3.send(new UploadPartCommand({ Bucket: bucket, Key: 'big.bin', UploadId, PartNumber: 2, Body: part2 }));

    const parts = await s3.send(new ListPartsCommand({ Bucket: bucket, Key: 'big.bin', UploadId }));
    assert.equal(parts.Parts.length, 2);

    const done = await s3.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: 'big.bin', UploadId,
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: u1.ETag }, { PartNumber: 2, ETag: u2.ETag }] },
    }));
    assert.match(done.ETag, /-2"?$/);   // multipart ETag carries the "-<partCount>" suffix

    const body = await readBody(await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'big.bin' })));
    assert.equal(body.length, 1536);
    assert.ok(body.subarray(0, 1024).every(b => b === 0x41));
    assert.ok(body.subarray(1024).every(b => b === 0x42));
  });

  it('abort removes the in-progress upload', async () => {
    const bucket = freshBucket();
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: 'x' }));
    await s3.send(new UploadPartCommand({ Bucket: bucket, Key: 'x', UploadId, PartNumber: 1, Body: Buffer.alloc(10) }));
    await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: 'x', UploadId }));
    const list = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
    assert.ok(!list.Uploads || list.Uploads.length === 0);
  });
});
