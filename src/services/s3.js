// services/s3.js — S3 service emulator
//
// Storage model: object bytes live on disk at ~/.mockcloud/s3/<bucket>/<key>
// so they survive restarts. Bucket metadata + a small RAM cache live in
// store.s3.buckets[name].objects[key] = { key, size, contentType, etag,
// modified, metadata }.
//
// We never load the body into RAM unless asked (GET / HEAD). For PUT, we
// stream-write to a temp file then rename (atomic on the same FS).
import { store, randomId } from '../store.js';
import { xmlResponse, escapeXml, getRawBuffer } from '../middleware/response.js';

// S3 uses <Error> as root, not <ErrorResponse> like other AWS services
function s3Error(res, statusCode, code, message) {
  xmlResponse(res, statusCode,
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`
  );
}
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync,
  rmSync, renameSync, statSync, readdirSync,
} from 'fs';

const S3_ROOT = process.env.MOCKCLOUD_S3_ROOT || path.join(os.homedir(), '.mockcloud', 's3');

// On startup, hydrate store.s3.buckets from disk. Idempotent.
hydrateFromDisk();

export async function handler(req, res) {
  const url       = new URL(req.url, 'http://localhost');
  const pathParts = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
  const method    = req.method;

  // ── List all buckets ────────────────────────────────────────────────────
  if (method === 'GET' && url.pathname === '/') {
    const buckets = Object.values(store.s3.buckets);
    return xmlResponse(res, 200,
      `<?xml version="1.0"?><ListAllMyBucketsResult><Buckets>${
        buckets.map(b => `<Bucket><Name>${escapeXml(b.name)}</Name><CreationDate>${new Date(b.created).toISOString()}</CreationDate></Bucket>`).join('')
      }</Buckets></ListAllMyBucketsResult>`);
  }

  const bucketName = pathParts[0];
  const objectKey  = pathParts.slice(1).join('/');

  if (!bucketName) {
    return xmlResponse(res, 200, '<?xml version="1.0"?><ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');
  }

  // ── Create bucket ───────────────────────────────────────────────────────
  // Guard: sub-resource PUTs (?website, ?acl, etc.) also have !objectKey — skip them here
  const hasSubResource = url.searchParams.has('website') || url.searchParams.has('acl') ||
    url.searchParams.has('publicAccessBlock') || url.searchParams.has('versioning') ||
    url.searchParams.has('policy') || url.searchParams.has('cors') ||
    url.searchParams.has('tagging') || url.searchParams.has('logging');
  if (method === 'PUT' && !objectKey && !hasSubResource) {
    if (store.s3.buckets[bucketName]) {
      return s3Error(res, 409, 'BucketAlreadyOwnedByYou', `Bucket ${bucketName} already exists`);
    }
    const region = req.headers['x-amz-bucket-region'] || 'us-east-1';
    store.s3.buckets[bucketName] = {
      name:    bucketName,
      region,
      created: Date.now(),
      objects: {},
      website: null,
      acl: 'private',
      publicAccessBlock: { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true },
      versioning: 'Suspended',
    };
    mkdirSync(path.join(S3_ROOT, bucketName), { recursive: true });
    store.addTrail({ method: 'PUT', path: `/s3/${bucketName}`, status: 200, latency: 2 });
    res.setHeader('Location', `/${bucketName}`);
    return xmlResponse(res, 200, '');
  }

  // ── Bucket sub-resource: ?website ───────────────────────────────────────
  if (!objectKey && url.searchParams.has('website')) {
    const bucket = store.s3.buckets[bucketName];
    if (!bucket) return s3Error(res, 404, 'NoSuchBucket', `Bucket ${bucketName} does not exist`);
    if (method === 'PUT') {
      const raw = getRawBuffer(req).toString();
      // Parse index/error document from XML
      const indexMatch = raw.match(/<Suffix>([^<]+)<\/Suffix>/);
      const errorMatch = raw.match(/<Key>([^<]+)<\/Key>/);
      bucket.website = { indexDocument: indexMatch?.[1] || 'index.html', errorDocument: errorMatch?.[1] || 'error.html' };
      res.writeHead(200); res.end(); return;
    }
    if (method === 'GET') {
      if (!bucket.website) return s3Error(res, 404, 'NoSuchWebsiteConfiguration', 'The specified bucket does not have a website configuration');
      const w = bucket.website;
      return xmlResponse(res, 200, `<?xml version="1.0"?><WebsiteConfiguration><IndexDocument><Suffix>${w.indexDocument}</Suffix></IndexDocument><ErrorDocument><Key>${w.errorDocument}</Key></ErrorDocument></WebsiteConfiguration>`);
    }
    if (method === 'DELETE') { bucket.website = null; res.writeHead(204); res.end(); return; }
  }

  // ── Bucket sub-resource: ?acl ────────────────────────────────────────────
  if (!objectKey && url.searchParams.has('acl')) {
    const bucket = store.s3.buckets[bucketName];
    if (!bucket) return s3Error(res, 404, 'NoSuchBucket', `Bucket ${bucketName} does not exist`);
    if (method === 'PUT') {
      const cannedAcl = req.headers['x-amz-acl'] || 'private';
      bucket.acl = cannedAcl;
      res.writeHead(200); res.end(); return;
    }
    if (method === 'GET') {
      return xmlResponse(res, 200, `<?xml version="1.0"?><AccessControlPolicy><Owner><ID>mockcloud</ID><DisplayName>mockcloud</DisplayName></Owner><AccessControlList><Grant><Grantee><ID>mockcloud</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`);
    }
  }

  // ── Bucket sub-resource: ?publicAccessBlock ──────────────────────────────
  if (!objectKey && url.searchParams.has('publicAccessBlock')) {
    const bucket = store.s3.buckets[bucketName];
    if (!bucket) return s3Error(res, 404, 'NoSuchBucket', `Bucket ${bucketName} does not exist`);
    if (method === 'PUT') {
      const raw = getRawBuffer(req).toString();
      bucket.publicAccessBlock = {
        blockPublicAcls:      /<BlockPublicAcls>true<\/BlockPublicAcls>/.test(raw),
        ignorePublicAcls:     /<IgnorePublicAcls>true<\/IgnorePublicAcls>/.test(raw),
        blockPublicPolicy:    /<BlockPublicPolicy>true<\/BlockPublicPolicy>/.test(raw),
        restrictPublicBuckets:/<RestrictPublicBuckets>true<\/RestrictPublicBuckets>/.test(raw),
      };
      res.writeHead(200); res.end(); return;
    }
    if (method === 'GET') {
      if (!bucket.publicAccessBlock) return s3Error(res, 404, 'NoSuchPublicAccessBlockConfiguration', 'The public access block configuration was not found');
      const p = bucket.publicAccessBlock;
      return xmlResponse(res, 200, `<?xml version="1.0"?><PublicAccessBlockConfiguration><BlockPublicAcls>${!!p.blockPublicAcls}</BlockPublicAcls><IgnorePublicAcls>${!!p.ignorePublicAcls}</IgnorePublicAcls><BlockPublicPolicy>${!!p.blockPublicPolicy}</BlockPublicPolicy><RestrictPublicBuckets>${!!p.restrictPublicBuckets}</RestrictPublicBuckets></PublicAccessBlockConfiguration>`);
    }
    if (method === 'DELETE') { bucket.publicAccessBlock = null; res.writeHead(204); res.end(); return; }
  }

  // ── Bucket sub-resource: ?versioning ────────────────────────────────────
  if (!objectKey && url.searchParams.has('versioning')) {
    const bucket = store.s3.buckets[bucketName];
    if (!bucket) return s3Error(res, 404, 'NoSuchBucket', `Bucket ${bucketName} does not exist`);
    if (method === 'PUT') {
      const raw = getRawBuffer(req).toString();
      const match = raw.match(/<Status>([^<]+)<\/Status>/);
      bucket.versioning = match?.[1] || 'Suspended';
      res.writeHead(200); res.end(); return;
    }
    if (method === 'GET') {
      return xmlResponse(res, 200, `<?xml version="1.0"?><VersioningConfiguration>${bucket.versioning ? `<Status>${bucket.versioning}</Status>` : ''}</VersioningConfiguration>`);
    }
  }

  // ── Bucket sub-resource: ?policy ────────────────────────────────────────
  if (!objectKey && url.searchParams.has('policy')) {
    const bucket = store.s3.buckets[bucketName];
    if (!bucket) return s3Error(res, 404, 'NoSuchBucket', `Bucket ${bucketName} does not exist`);
    if (method === 'PUT') { bucket.policy = getRawBuffer(req).toString(); res.writeHead(204); res.end(); return; }
    if (method === 'GET') {
      if (!bucket.policy) return s3Error(res, 404, 'NoSuchBucketPolicy', 'The bucket policy does not exist');
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(bucket.policy); return;
    }
    if (method === 'DELETE') { bucket.policy = null; res.writeHead(204); res.end(); return; }
  }

  // ── Bucket sub-resource: ?cors ───────────────────────────────────────────
  if (!objectKey && url.searchParams.has('cors')) {
    const bucket = store.s3.buckets[bucketName];
    if (!bucket) return s3Error(res, 404, 'NoSuchBucket', `Bucket ${bucketName} does not exist`);
    if (method === 'PUT') { bucket.cors = getRawBuffer(req).toString(); res.writeHead(200); res.end(); return; }
    if (method === 'GET') {
      if (!bucket.cors) return s3Error(res, 404, 'NoSuchCORSConfiguration', 'No CORS configuration');
      return xmlResponse(res, 200, bucket.cors);
    }
    if (method === 'DELETE') { bucket.cors = null; res.writeHead(204); res.end(); return; }
  }

  // ── Bucket sub-resource: ?tagging ───────────────────────────────────────
  if (!objectKey && url.searchParams.has('tagging')) {
    const bucket = store.s3.buckets[bucketName];
    if (!bucket) return s3Error(res, 404, 'NoSuchBucket', `Bucket ${bucketName} does not exist`);
    if (method === 'PUT') {
      const raw = getRawBuffer(req).toString();
      const tags = {};
      const tagRe = /<Tag><Key>([^<]*)<\/Key><Value>([^<]*)<\/Value><\/Tag>/g;
      let m;
      while ((m = tagRe.exec(raw)) !== null) tags[m[1]] = m[2];
      bucket.tags = tags;
      res.writeHead(204); res.end(); return;
    }
    if (method === 'GET') {
      const tags = bucket.tags || {};
      const tagXml = Object.entries(tags).map(([k, v]) =>
        `<Tag><Key>${escapeXml(k)}</Key><Value>${escapeXml(v)}</Value></Tag>`
      ).join('');
      return xmlResponse(res, 200,
        `<?xml version="1.0" encoding="UTF-8"?><Tagging><TagSet>${tagXml}</TagSet></Tagging>`);
    }
    if (method === 'DELETE') { bucket.tags = {}; res.writeHead(204); res.end(); return; }
  }

  // ── Delete bucket ───────────────────────────────────────────────────────
  if (method === 'DELETE' && !objectKey) {
    if (!store.s3.buckets[bucketName]) return s3Error(res, 404, 'NoSuchBucket', `Bucket ${bucketName} does not exist`);
    if (Object.keys(store.s3.buckets[bucketName].objects).length > 0) {
      return s3Error(res, 409, 'BucketNotEmpty', 'The bucket you tried to delete is not empty');
    }
    delete store.s3.buckets[bucketName];
    try { rmSync(path.join(S3_ROOT, bucketName), { recursive: true, force: true }); } catch {}
    store.addTrail({ method: 'DELETE', path: `/s3/${bucketName}`, status: 204, latency: 1 });
    res.writeHead(204); res.end();
    return;
  }

  // ── Head bucket ─────────────────────────────────────────────────────────
  if (method === 'HEAD' && !objectKey) {
    if (!store.s3.buckets[bucketName]) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'x-amz-bucket-region': store.s3.buckets[bucketName].region });
    res.end(); return;
  }

  // ── List objects ────────────────────────────────────────────────────────
  if (method === 'GET' && !objectKey) {
    const bucket = store.s3.buckets[bucketName];
    if (!bucket) return s3Error(res, 404, 'NoSuchBucket', `Bucket ${bucketName} does not exist`);
    const prefix    = url.searchParams.get('prefix') || '';
    const maxKeys   = parseInt(url.searchParams.get('max-keys') || '1000');
    const listType  = url.searchParams.get('list-type'); // '2' for ListObjectsV2
    const objects   = Object.values(bucket.objects)
      .filter(o => o.key.startsWith(prefix))
      .slice(0, maxKeys);
    const contents = objects.map(o =>
      `<Contents><Key>${escapeXml(o.key)}</Key><Size>${o.size}</Size><LastModified>${new Date(o.modified).toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><StorageClass>STANDARD</StorageClass></Contents>`
    ).join('');
    const keyCount = listType === '2' ? `<KeyCount>${objects.length}</KeyCount>` : '';
    return xmlResponse(res, 200,
      `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${escapeXml(bucketName)}</Name><Prefix>${escapeXml(prefix)}</Prefix><MaxKeys>${maxKeys}</MaxKeys>${keyCount}<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
  }

  const bucket = store.s3.buckets[bucketName];

  // ── Head object ─────────────────────────────────────────────────────────
  if (method === 'HEAD' && objectKey) {
    if (!bucket) { res.writeHead(404); res.end(); return; }
    const obj = bucket.objects[objectKey];
    if (!obj) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Length': obj.size,
      'Content-Type':   obj.contentType,
      'ETag':           `"${obj.etag}"`,
      'Last-Modified':  new Date(obj.modified).toUTCString(),
      ...metaHeaders(obj.metadata),
    });
    res.end(); return;
  }

  // ── Get object ──────────────────────────────────────────────────────────
  if (method === 'GET' && objectKey) {
    if (!bucket) return s3Error(res, 404, 'NoSuchBucket', `No such bucket`);
    const obj = bucket.objects[objectKey];
    if (!obj) return s3Error(res, 404, 'NoSuchKey', `The specified key does not exist.`);
    let buf;
    try { buf = readObjectFromDisk(bucketName, objectKey); }
    catch { return s3Error(res, 500, 'InternalError', 'Failed to read object body'); }
    res.writeHead(200, {
      'Content-Type':   obj.contentType || 'application/octet-stream',
      'Content-Length': buf.length,
      'ETag':           `"${obj.etag}"`,
      'Last-Modified':  new Date(obj.modified).toUTCString(),
      ...metaHeaders(obj.metadata),
    });
    res.end(buf);
    return;
  }

  // ── Put object ──────────────────────────────────────────────────────────
  if (method === 'PUT' && objectKey) {
    if (!bucket) return s3Error(res, 404, 'NoSuchBucket', `No such bucket`);
    const buf  = getRawBuffer(req);
    const etag = crypto.createHash('md5').update(buf).digest('hex');
    try { writeObjectToDisk(bucketName, objectKey, buf); }
    catch (e) { return s3Error(res, 500, 'InternalError', `Failed to persist object: ${e.message}`); }
    bucket.objects[objectKey] = {
      key:         objectKey,
      size:        buf.length,
      contentType: req.headers['content-type'] || 'application/octet-stream',
      etag,
      modified:    Date.now(),
      metadata:    extractMetadata(req.headers),
    };
    store.addTrail({ method: 'PUT', path: `/s3/${bucketName}/${objectKey}`, status: 200, latency: 2 });
    res.writeHead(200, { 'ETag': `"${etag}"` });
    res.end(); return;
  }

  // ── Delete object ───────────────────────────────────────────────────────
  if (method === 'DELETE' && objectKey) {
    if (!bucket) return s3Error(res, 404, 'NoSuchBucket', `No such bucket`);
    delete bucket.objects[objectKey];
    try { rmSync(diskPath(bucketName, objectKey), { force: true }); } catch {}
    store.addTrail({ method: 'DELETE', path: `/s3/${bucketName}/${objectKey}`, status: 204, latency: 1 });
    res.writeHead(204); res.end(); return;
  }

  s3Error(res, 400, 'InvalidRequest', 'Unknown S3 operation');
}

// ── Helpers used by routes/s3.js (UI upload) ───────────────────────────────
// Exporting these lets the UI route share the same persistence path without
// duplicating the disk-write logic.
export function putObjectToBucket(bucketName, key, buf, contentType, metadata = {}) {
  const bucket = store.s3.buckets[bucketName];
  if (!bucket) throw new Error(`Bucket ${bucketName} does not exist`);
  const etag = crypto.createHash('md5').update(buf).digest('hex');
  writeObjectToDisk(bucketName, key, buf);
  bucket.objects[key] = {
    key,
    size:        buf.length,
    contentType: contentType || 'application/octet-stream',
    etag,
    modified:    Date.now(),
    metadata,
  };
  return bucket.objects[key];
}

// ── Disk persistence helpers ───────────────────────────────────────────────
// Keys can contain '/'. We mirror that into the directory tree on disk.
// We don't sanitize the key beyond preventing `..` escape — S3 allows almost
// any character in keys, and this is a local dev tool listening on 127.0.0.1.
function diskPath(bucket, key) {
  const safeKey = key.split('/').map(p => p === '..' ? '__' : p).join('/');
  return path.join(S3_ROOT, bucket, safeKey);
}

function writeObjectToDisk(bucket, key, buf) {
  const target  = diskPath(bucket, key);
  const tmpPath = target + '.tmp-' + randomId(8);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(tmpPath, buf);
  // Rename is atomic on POSIX and same-FS on Windows
  try { renameSync(tmpPath, target); }
  catch {
    // fallback for cross-FS or weird Windows cases
    writeFileSync(target, buf);
    try { rmSync(tmpPath, { force: true }); } catch {}
  }
}

function readObjectFromDisk(bucket, key) {
  return readFileSync(diskPath(bucket, key));
}

function hydrateFromDisk() {
  if (!existsSync(S3_ROOT)) return;
  let bucketDirs;
  try { bucketDirs = readdirSync(S3_ROOT, { withFileTypes: true }); } catch { return; }
  for (const entry of bucketDirs) {
    if (!entry.isDirectory()) continue;
    const bucketName = entry.name;
    if (store.s3.buckets[bucketName]) continue;
    const bucketPath = path.join(S3_ROOT, bucketName);
    const objects    = {};
    walkObjects(bucketPath, '', objects);
    store.s3.buckets[bucketName] = {
      name:    bucketName,
      region:  'us-east-1',
      created: safeMtime(bucketPath),
      objects,
    };
  }
}

function walkObjects(dir, prefix, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.includes('.tmp-')) continue;          // skip stale temp files
    const full = path.join(dir, e.name);
    const key  = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) walkObjects(full, key, out);
    else if (e.isFile()) {
      const st  = statSync(full);
      // Only hash files under 5MB on hydrate to keep startup fast; larger
      // objects get a synthetic etag based on size+mtime until next PUT.
      let etag;
      if (st.size <= 5 * 1024 * 1024) {
        etag = crypto.createHash('md5').update(readFileSync(full)).digest('hex');
      } else {
        etag = crypto.createHash('md5').update(`${st.size}-${st.mtimeMs}`).digest('hex');
      }
      out[key] = {
        key,
        size:        st.size,
        contentType: 'application/octet-stream',
        etag,
        modified:    st.mtimeMs,
        metadata:    {},
      };
    }
  }
}

function safeMtime(p) { try { return statSync(p).mtimeMs; } catch { return Date.now(); } }

function metaHeaders(meta) {
  return Object.fromEntries(Object.entries(meta || {}).map(([k, v]) => [`x-amz-meta-${k}`, v]));
}

function extractMetadata(headers) {
  const meta = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith('x-amz-meta-')) meta[k.slice(11)] = v;
  }
  return meta;
}
