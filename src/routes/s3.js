// routes/s3.js — /mockcloud/s3/* UI API
//
// Object operations use ?key=<encodedKey> in the query string rather than
// :key in the path, because S3 keys can contain slashes and the internal
// router's :param syntax can't capture across `/`.
import { store } from '../store.js';
import { jsonResponse, errorJson, getRawBuffer } from '../middleware/response.js';
import { putObjectToBucket, isValidBucketName } from '../services/s3.js';
import { safeJoin } from '../middleware/http.js';
import path from 'path';
import os from 'os';
import { readFileSync, rmSync } from 'fs';

const body = req => req.parsedBody || {};
// Honour the test override (tests set MOCKCLOUD_S3_ROOT to a per-pid tmpdir
// so disk hydration in services/s3.js targets the same location).
const S3_ROOT = process.env.MOCKCLOUD_S3_ROOT || path.join(os.homedir(), '.mockcloud', 's3');

export function registerS3Routes(app) {

  app.get('/mockcloud/s3/buckets', (req, res) => {
    const buckets = Object.values(store.s3.buckets).map(b => ({
      name:        b.name,
      region:      b.region,
      created:     b.created,
      objectCount: Object.keys(b.objects).length,
      totalSize:   Object.values(b.objects).reduce((s, o) => s + o.size, 0),
    }));
    jsonResponse(res, 200, { buckets });
  });

  app.post('/mockcloud/s3/buckets', (req, res) => {
    const { name, region } = body(req);
    if (!name) return errorJson(res, 400, 'ValidationError', 'name required');
    if (!isValidBucketName(name)) {
      return errorJson(res, 400, 'ValidationError', 'bucket name must match AWS naming rules (3-63 chars, lowercase alphanumeric, dots, hyphens)');
    }
    if (store.s3.buckets[name]) return errorJson(res, 409, 'Conflict', 'Bucket already exists');
    store.s3.buckets[name] = { name, region: region || 'us-east-1', created: Date.now(), objects: {} };
    store.addTrail({ method: 'POST', path: `/s3/${name}`, status: 200, latency: 2 });
    jsonResponse(res, 201, store.s3.buckets[name]);
  });

  app.delete('/mockcloud/s3/buckets/:name', (req, res) => {
    const { name } = req.params;
    if (!store.s3.buckets[name]) return errorJson(res, 404, 'NotFound', 'Bucket not found');
    if (Object.keys(store.s3.buckets[name].objects).length > 0)
      return errorJson(res, 409, 'Conflict', 'Bucket not empty');
    delete store.s3.buckets[name];
    store.addTrail({ method: 'DELETE', path: `/s3/${name}`, status: 200, latency: 1 });
    jsonResponse(res, 200, { deleted: name });
  });

  app.get('/mockcloud/s3/buckets/:name/objects', (req, res) => {
    const b = store.s3.buckets[req.params.name];
    if (!b) return errorJson(res, 404, 'NotFound', 'Bucket not found');
    jsonResponse(res, 200, {
      objects: Object.values(b.objects).map(o => ({
        key: o.key, size: o.size, contentType: o.contentType, modified: o.modified, etag: o.etag,
      })),
      bucket: req.params.name,
    });
  });

  // ── Upload object ──────────────────────────────────────────────────────
  // POST /mockcloud/s3/buckets/:name/objects?key=<encodedKey>
  // Body: raw file bytes. Content-Type header preserved.
  app.post('/mockcloud/s3/buckets/:name/objects', (req, res) => {
    const { name } = req.params;
    const key = req.query?.key;
    if (!key) return errorJson(res, 400, 'ValidationError', 'key query param required');
    if (!store.s3.buckets[name]) return errorJson(res, 404, 'NotFound', 'Bucket not found');
    const buf = getRawBuffer(req);
    if (!buf || buf.length === 0) return errorJson(res, 400, 'ValidationError', 'empty body');
    try {
      const obj = putObjectToBucket(name, key, buf, req.headers['content-type'] || 'application/octet-stream');
      store.addTrail({ method: 'POST', path: `/s3/${name}/${key}`, status: 200, latency: 2 });
      jsonResponse(res, 201, { key: obj.key, size: obj.size, etag: obj.etag, contentType: obj.contentType });
    } catch (e) {
      errorJson(res, 500, 'UploadFailed', e.message);
    }
  });

  // ── Download object ────────────────────────────────────────────────────
  // GET /mockcloud/s3/buckets/:name/object?key=<encodedKey>
  app.get('/mockcloud/s3/buckets/:name/object', (req, res) => {
    const { name } = req.params;
    const key = req.query?.key;
    if (!key) return errorJson(res, 400, 'ValidationError', 'key query param required');
    const b = store.s3.buckets[name];
    if (!b) return errorJson(res, 404, 'NotFound', 'Bucket not found');
    const obj = b.objects[key];
    if (!obj) return errorJson(res, 404, 'NotFound', 'Object not found');
    let buf;
    try { buf = readFileSync(diskPath(name, key)); }
    catch { return errorJson(res, 500, 'ReadFailed', 'Could not read object body'); }
    res.writeHead(200, {
      'Content-Type':        obj.contentType || 'application/octet-stream',
      'Content-Length':      buf.length,
      'Content-Disposition': `attachment; filename="${path.basename(key)}"`,
      'ETag':                `"${obj.etag}"`,
    });
    res.end(buf);
  });

  // ── Delete object ──────────────────────────────────────────────────────
  // DELETE /mockcloud/s3/buckets/:name/object?key=<encodedKey>
  // (Was /objects/:key — broken for keys with slashes; this replaces it.)
  app.delete('/mockcloud/s3/buckets/:name/object', (req, res) => {
    const { name } = req.params;
    const key = req.query?.key;
    if (!key) return errorJson(res, 400, 'ValidationError', 'key query param required');
    const b = store.s3.buckets[name];
    if (!b) return errorJson(res, 404, 'NotFound', 'Bucket not found');
    // Object must be registered via the API before we delete its on-disk
    // file. Without this check, attackers could probe for arbitrary file
    // paths under a bad-named bucket — rmSync({ force: true }) silences
    // ENOENT and they'd still get a 200 either way.
    if (!Object.prototype.hasOwnProperty.call(b.objects, key)) {
      return errorJson(res, 404, 'NotFound', 'Object not found');
    }
    delete b.objects[key];
    try { rmSync(diskPath(name, key), { force: true }); } catch {}
    store.addTrail({ method: 'DELETE', path: `/s3/${name}/${key}`, status: 200, latency: 1 });
    jsonResponse(res, 200, { deleted: key });
  });
}

function diskPath(bucket, key) {
  const safeKey = key.split('/').map(p => p === '..' ? '__' : p).join('/');
  // safeJoin throws 'path escape' if bucket/key would resolve outside
  // S3_ROOT — defense in depth on top of bucket-name validation at the
  // create handler.
  return safeJoin(S3_ROOT, bucket, safeKey);
}
