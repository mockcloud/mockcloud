// services/secretsmanager.js
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson, getRawBody } from '../middleware/response.js';

export async function handler(req, res) {
  const target = req.headers['x-amz-target'] || '';
  const op = target.split('.').pop();
  const body = getRawBody(req);
  let payload = {};
  try { payload = JSON.parse(body); } catch {}

  switch (op) {
    case 'CreateSecret': {
      const name = payload.Name;
      if (!name) return errorJson(res, 400, 'ValidationException', 'Name required');
      if (store.secretsmanager.secrets[name]) return errorJson(res, 400, 'ResourceExistsException', `Secret already exists: ${name}`);
      const value = payload.SecretString || payload.SecretBinary || '';
      const a = arn('secretsmanager', `secret:${name}`);
      store.secretsmanager.secrets[name] = { name, arn: a, value, created: Date.now(), updated: Date.now(), rotation: 'never', versions: [{ id: 'v-1', stage: 'AWSCURRENT', created: Date.now() }] };
      return jsonResponse(res, 200, { ARN: a, Name: name, VersionId: 'v-1' });
    }
    case 'GetSecretValue': {
      const id = payload.SecretId;
      const secret = store.secretsmanager.secrets[id];
      if (!secret) return errorJson(res, 400, 'ResourceNotFoundException', `Secret not found: ${id}`);
      return jsonResponse(res, 200, { ARN: secret.arn, Name: secret.name, SecretString: secret.value, CreatedDate: secret.created/1000, VersionId: 'v-1' });
    }
    case 'PutSecretValue': {
      const id = payload.SecretId;
      const secret = store.secretsmanager.secrets[id];
      if (!secret) return errorJson(res, 400, 'ResourceNotFoundException', `Secret not found: ${id}`);
      const oldVersion = secret.versions[0];
      if (oldVersion) oldVersion.stage = 'AWSPREVIOUS';
      secret.value = payload.SecretString || payload.SecretBinary || secret.value;
      secret.updated = Date.now();
      const newVer = { id: `v-${secret.versions.length+1}`, stage: 'AWSCURRENT', created: Date.now() };
      secret.versions.unshift(newVer);
      return jsonResponse(res, 200, { ARN: secret.arn, Name: secret.name, VersionId: newVer.id });
    }
    case 'DeleteSecret': {
      const id = payload.SecretId;
      if (!store.secretsmanager.secrets[id]) return errorJson(res, 400, 'ResourceNotFoundException', `Secret not found: ${id}`);
      const secret = store.secretsmanager.secrets[id];
      const deletionDate = new Date(Date.now() + 30*24*60*60*1000).toISOString();
      delete store.secretsmanager.secrets[id];
      return jsonResponse(res, 200, { ARN: secret.arn, Name: secret.name, DeletionDate: deletionDate });
    }
    case 'ListSecrets': {
      const secrets = Object.values(store.secretsmanager.secrets).map(s => ({ ARN: s.arn, Name: s.name, LastChangedDate: s.updated/1000, LastAccessedDate: s.updated/1000 }));
      return jsonResponse(res, 200, { SecretList: secrets });
    }
    case 'DescribeSecret': {
      const id = payload.SecretId;
      const secret = store.secretsmanager.secrets[id];
      if (!secret) return errorJson(res, 400, 'ResourceNotFoundException', `Secret not found: ${id}`);
      return jsonResponse(res, 200, { ARN: secret.arn, Name: secret.name, CreatedDate: secret.created/1000, LastChangedDate: secret.updated/1000, VersionIdsToStages: Object.fromEntries(secret.versions.map(v=>[v.id,[v.stage]])) });
    }
    default:
      return errorJson(res, 400, 'UnknownOperationException', `Unknown SM operation: ${op}`);
  }
}
