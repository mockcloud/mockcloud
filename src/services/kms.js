// services/kms.js — AWS KMS emulator
// Handles GenerateDataKey, Encrypt, Decrypt, CreateKey, DescribeKey, ListKeys
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

function parseBody(req) {
  try { return JSON.parse(req.rawBody || '{}'); } catch { return {}; }
}

const TARGET_MAP = {
  'TrentService.CreateKey':        createKey,
  'TrentService.DescribeKey':      describeKey,
  'TrentService.ListKeys':         listKeys,
  'TrentService.GenerateDataKey':  generateDataKey,
  'TrentService.GenerateDataKeyWithoutPlaintext': generateDataKeyNoPlaintext,
  'TrentService.Encrypt':          encrypt,
  'TrentService.Decrypt':          decrypt,
  'TrentService.ScheduleKeyDeletion': scheduleKeyDeletion,
  'TrentService.CancelKeyDeletion':   cancelKeyDeletion,
  'TrentService.EnableKey':        enableKey,
  'TrentService.DisableKey':       disableKey,
  'TrentService.GetKeyPolicy':     getKeyPolicy,
  'TrentService.PutKeyPolicy':     (req, res) => jsonResponse(res, 200, {}),
  'TrentService.ListAliases':      listAliases,
  'TrentService.CreateAlias':      (req, res) => jsonResponse(res, 200, {}),
};

export function handler(req, res) {
  const target = req.headers['x-amz-target'] || '';
  const fn = TARGET_MAP[target];
  if (fn) return fn(req, res);
  return errorJson(res, 400, 'InvalidAction', `Unknown KMS action: ${target}`);
}

function mkKey(description, usage, spec) {
  const id = randomId(8) + '-' + randomId(4) + '-' + randomId(4) + '-' + randomId(4) + '-' + randomId(12);
  return {
    KeyId:                id,
    Arn:                  arn('kms', `key/${id}`),
    Description:          description || '',
    KeyUsage:             usage || 'ENCRYPT_DECRYPT',
    KeySpec:              spec  || 'SYMMETRIC_DEFAULT',
    KeyState:             'Enabled',
    CreationDate:         Date.now() / 1000,
    Enabled:              true,
    MultiRegion:          false,
    Origin:               'AWS_KMS',
    KeyManager:           'CUSTOMER',
  };
}

function createKey(req, res) {
  const b = parseBody(req);
  const key = mkKey(b.Description, b.KeyUsage, b.KeySpec);
  store.kms.keys[key.KeyId] = key;
  store.addTrail({ method: 'POST', path: '/kms/CreateKey', status: 200, latency: 5 });
  jsonResponse(res, 200, { KeyMetadata: key });
}

function describeKey(req, res) {
  const b = parseBody(req);
  const keyId = resolveKeyId(b.KeyId);
  const key = store.kms.keys[keyId];
  if (!key) return errorJson(res, 400, 'NotFoundException', `Invalid keyId ${b.KeyId}`);
  jsonResponse(res, 200, { KeyMetadata: key });
}

function listKeys(req, res) {
  jsonResponse(res, 200, {
    Keys: Object.values(store.kms.keys).map(k => ({ KeyId: k.KeyId, KeyArn: k.Arn })),
    Truncated: false,
  });
}

function generateDataKey(req, res) {
  const b = parseBody(req);
  const keyId = resolveKeyId(b.KeyId);
  if (!store.kms.keys[keyId]) {
    // Auto-create if referencing unknown key — common in Terraform
    const key = mkKey('auto-created', 'ENCRYPT_DECRYPT', 'SYMMETRIC_DEFAULT');
    key.KeyId = keyId;
    key.Arn = arn('kms', `key/${keyId}`);
    store.kms.keys[keyId] = key;
  }
  const plaintext = Buffer.from(randomId(32)).toString('base64');
  const ciphertext = Buffer.from(`mockcloud-enc:${keyId}:${randomId(32)}`).toString('base64');
  store.addTrail({ method: 'POST', path: '/kms/GenerateDataKey', status: 200, latency: 3 });
  jsonResponse(res, 200, {
    KeyId:            arn('kms', `key/${keyId}`),
    Plaintext:        plaintext,
    CiphertextBlob:   ciphertext,
  });
}

function generateDataKeyNoPlaintext(req, res) {
  const b = parseBody(req);
  const keyId = resolveKeyId(b.KeyId);
  const ciphertext = Buffer.from(`mockcloud-enc:${keyId}:${randomId(32)}`).toString('base64');
  jsonResponse(res, 200, {
    KeyId:          arn('kms', `key/${keyId}`),
    CiphertextBlob: ciphertext,
  });
}

function encrypt(req, res) {
  const b = parseBody(req);
  const keyId = resolveKeyId(b.KeyId);
  const ciphertext = Buffer.from(`mockcloud-enc:${keyId}:${b.Plaintext}`).toString('base64');
  store.addTrail({ method: 'POST', path: '/kms/Encrypt', status: 200, latency: 2 });
  jsonResponse(res, 200, {
    KeyId:          arn('kms', `key/${keyId}`),
    CiphertextBlob: ciphertext,
    EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
  });
}

function decrypt(req, res) {
  const b = parseBody(req);
  try {
    const raw = Buffer.from(b.CiphertextBlob, 'base64').toString();
    const parts = raw.split(':');
    const keyId = parts[1] || 'unknown';
    const plaintext = parts[2] ? Buffer.from(parts[2]).toString('base64') : Buffer.from(randomId(16)).toString('base64');
    store.addTrail({ method: 'POST', path: '/kms/Decrypt', status: 200, latency: 2 });
    jsonResponse(res, 200, {
      KeyId:     arn('kms', `key/${keyId}`),
      Plaintext: plaintext,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
    });
  } catch {
    errorJson(res, 400, 'InvalidCiphertextException', 'Invalid ciphertext');
  }
}

function scheduleKeyDeletion(req, res) {
  const b = parseBody(req);
  const keyId = resolveKeyId(b.KeyId);
  const key = store.kms.keys[keyId];
  if (!key) return errorJson(res, 400, 'NotFoundException', `Invalid keyId ${b.KeyId}`);
  const days = b.PendingWindowInDays || 30;
  key.KeyState = 'PendingDeletion';
  key.DeletionDate = (Date.now() / 1000) + (days * 86400);
  jsonResponse(res, 200, { KeyId: key.Arn, DeletionDate: key.DeletionDate });
}

function cancelKeyDeletion(req, res) {
  const b = parseBody(req);
  const keyId = resolveKeyId(b.KeyId);
  const key = store.kms.keys[keyId];
  if (!key) return errorJson(res, 400, 'NotFoundException', `Invalid keyId ${b.KeyId}`);
  key.KeyState = 'Disabled';
  delete key.DeletionDate;
  jsonResponse(res, 200, { KeyMetadata: key });
}

function enableKey(req, res) {
  const b = parseBody(req);
  const keyId = resolveKeyId(b.KeyId);
  const key = store.kms.keys[keyId];
  if (key) { key.KeyState = 'Enabled'; key.Enabled = true; }
  jsonResponse(res, 200, {});
}

function disableKey(req, res) {
  const b = parseBody(req);
  const keyId = resolveKeyId(b.KeyId);
  const key = store.kms.keys[keyId];
  if (key) { key.KeyState = 'Disabled'; key.Enabled = false; }
  jsonResponse(res, 200, {});
}

function getKeyPolicy(req, res) {
  jsonResponse(res, 200, {
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::000000000000:root' }, Action: 'kms:*', Resource: '*' }],
    }),
  });
}

function listAliases(req, res) {
  const aliases = Object.values(store.kms.keys).map(k => ({
    AliasName:   `alias/mockcloud-${k.KeyId.slice(0, 8)}`,
    AliasArn:    arn('kms', `alias/mockcloud-${k.KeyId.slice(0, 8)}`),
    TargetKeyId: k.KeyId,
  }));
  jsonResponse(res, 200, { Aliases: aliases, Truncated: false });
}

// Resolve key alias / ARN / ID → bare key ID
function resolveKeyId(keyId) {
  if (!keyId) return randomId(8);
  if (keyId.startsWith('arn:')) return keyId.split('/').pop();
  if (keyId.startsWith('alias/')) {
    const found = Object.values(store.kms.keys).find(k =>
      k.Aliases?.includes(keyId));
    return found?.KeyId || randomId(8);
  }
  return keyId;
}
