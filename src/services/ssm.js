// services/ssm.js — AWS SSM Parameter Store emulator
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

function parseBody(req) {
  try { return JSON.parse(req.rawBody || '{}'); } catch { return {}; }
}

const TARGET_MAP = {
  'AmazonSSM.PutParameter':            putParameter,
  'AmazonSSM.GetParameter':            getParameter,
  'AmazonSSM.GetParameters':           getParameters,
  'AmazonSSM.GetParametersByPath':     getParametersByPath,
  'AmazonSSM.DeleteParameter':         deleteParameter,
  'AmazonSSM.DeleteParameters':        deleteParameters,
  'AmazonSSM.DescribeParameters':      describeParameters,
  'AmazonSSM.GetParameterHistory':     getParameterHistory,
  'AmazonSSM.LabelParameterVersion':   (req, res) => jsonResponse(res, 200, { InvalidLabels: [], AddedLabels: [] }),
  'AmazonSSM.AddTagsToResource':       (req, res) => jsonResponse(res, 200, {}),
  'AmazonSSM.ListTagsForResource':     (req, res) => jsonResponse(res, 200, { TagList: [] }),
};

export function handler(req, res) {
  const target = req.headers['x-amz-target'] || '';
  const fn = TARGET_MAP[target];
  if (fn) return fn(req, res);
  return errorJson(res, 400, 'InvalidAction', `Unknown SSM action: ${target}`);
}

function putParameter(req, res) {
  const b = parseBody(req);
  if (!b.Name) return errorJson(res, 400, 'ValidationException', 'Name required');
  const existing = store.ssm.parameters[b.Name];
  if (existing && !b.Overwrite)
    return errorJson(res, 400, 'ParameterAlreadyExists', `Parameter ${b.Name} already exists`);
  const version = (existing?.Version || 0) + 1;
  store.ssm.parameters[b.Name] = {
    Name:             b.Name,
    Value:            b.Value || '',
    Type:             b.Type || 'String',
    Version:          version,
    LastModifiedDate: Date.now() / 1000,
    ARN:              arn('ssm', `parameter${b.Name}`),
    DataType:         b.DataType || 'text',
    Description:      b.Description || '',
    Tier:             b.Tier || 'Standard',
    history:          [...(existing?.history || []), { Value: b.Value, Version: version, LastModifiedDate: Date.now() / 1000 }],
  };
  store.addTrail({ method: 'POST', path: `/ssm${b.Name}`, status: 200, latency: 3 });
  jsonResponse(res, 200, { Version: version, Tier: 'Standard' });
}

function getParameter(req, res) {
  const b = parseBody(req);
  const p = store.ssm.parameters[b.Name];
  if (!p) return errorJson(res, 400, 'ParameterNotFound', `Parameter ${b.Name} not found`);
  const param = { ...p };
  delete param.history;
  jsonResponse(res, 200, { Parameter: param });
}

function getParameters(req, res) {
  const b = parseBody(req);
  const names = b.Names || [];
  const found = [], invalid = [];
  for (const name of names) {
    const p = store.ssm.parameters[name];
    if (p) { const param = { ...p }; delete param.history; found.push(param); }
    else invalid.push(name);
  }
  jsonResponse(res, 200, { Parameters: found, InvalidParameters: invalid });
}

function getParametersByPath(req, res) {
  const b = parseBody(req);
  const path = b.Path || '/';
  const recursive = b.Recursive !== false;
  const params = Object.values(store.ssm.parameters)
    .filter(p => {
      if (recursive) return p.Name.startsWith(path);
      const rest = p.Name.slice(path.length);
      return p.Name.startsWith(path) && !rest.slice(1).includes('/');
    })
    .map(p => { const param = { ...p }; delete param.history; return param; });
  jsonResponse(res, 200, { Parameters: params });
}

function deleteParameter(req, res) {
  const b = parseBody(req);
  if (!store.ssm.parameters[b.Name])
    return errorJson(res, 400, 'ParameterNotFound', `Parameter ${b.Name} not found`);
  delete store.ssm.parameters[b.Name];
  store.addTrail({ method: 'DELETE', path: `/ssm${b.Name}`, status: 200, latency: 2 });
  jsonResponse(res, 200, {});
}

function deleteParameters(req, res) {
  const b = parseBody(req);
  const deleted = [], invalid = [];
  for (const name of (b.Names || [])) {
    if (store.ssm.parameters[name]) { delete store.ssm.parameters[name]; deleted.push(name); }
    else invalid.push(name);
  }
  jsonResponse(res, 200, { DeletedParameters: deleted, InvalidParameters: invalid });
}

function describeParameters(req, res) {
  const params = Object.values(store.ssm.parameters).map(p => ({
    Name:             p.Name,
    Type:             p.Type,
    Version:          p.Version,
    LastModifiedDate: p.LastModifiedDate,
    ARN:              p.ARN,
    DataType:         p.DataType,
    Tier:             p.Tier,
  }));
  jsonResponse(res, 200, { Parameters: params });
}

function getParameterHistory(req, res) {
  const b = parseBody(req);
  const p = store.ssm.parameters[b.Name];
  if (!p) return errorJson(res, 400, 'ParameterNotFound', `Parameter ${b.Name} not found`);
  jsonResponse(res, 200, { Parameters: p.history || [] });
}
