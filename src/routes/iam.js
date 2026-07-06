// routes/iam.js — /mockcloud/iam/* UI API
import { store, iamArn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

const body = req => req.parsedBody || {};

export function registerIAMRoutes(app) {

  // Users
  app.get('/mockcloud/iam/users', (req, res) => {
    jsonResponse(res, 200, { users: Object.values(store.iam.users) });
  });

  app.post('/mockcloud/iam/users', (req, res) => {
    const { name, policies } = body(req);
    if (!name) return errorJson(res, 400, 'ValidationError', 'name required');
    if (store.iam.users[name]) return errorJson(res, 409, 'Conflict', 'User already exists');
    store.iam.users[name] = {
      name, arn: iamArn(`user/${name}`),
      created: Date.now(), groups: [], policies: policies || [], mfa: false, accessKeys: [],
    };
    store.addTrail({ method: 'POST', path: `/iam/users/${name}`, status: 201, latency: 3 });
    jsonResponse(res, 201, store.iam.users[name]);
  });

  app.delete('/mockcloud/iam/users/:name', (req, res) => {
    delete store.iam.users[req.params.name];
    store.addTrail({ method: 'DELETE', path: `/iam/users/${req.params.name}`, status: 200, latency: 1 });
    jsonResponse(res, 200, { deleted: req.params.name });
  });

  // Roles
  app.get('/mockcloud/iam/roles', (req, res) => {
    jsonResponse(res, 200, { roles: Object.values(store.iam.roles) });
  });

  app.post('/mockcloud/iam/roles', (req, res) => {
    const { name, policies } = body(req);
    if (!name) return errorJson(res, 400, 'ValidationError', 'name required');
    if (store.iam.roles[name]) return errorJson(res, 409, 'Conflict', 'Role already exists');
    store.iam.roles[name] = {
      name, arn: iamArn(`role/${name}`),
      created: Date.now(), policies: policies || [], attached: 0,
    };
    store.addTrail({ method: 'POST', path: `/iam/roles/${name}`, status: 201, latency: 3 });
    jsonResponse(res, 201, store.iam.roles[name]);
  });

  app.delete('/mockcloud/iam/roles/:name', (req, res) => {
    delete store.iam.roles[req.params.name];
    store.addTrail({ method: 'DELETE', path: `/iam/roles/${req.params.name}`, status: 200, latency: 1 });
    jsonResponse(res, 200, { deleted: req.params.name });
  });

  // ── Identity policies (for opt-in MOCKCLOUD_IAM evaluation) ───────────────
  app.get('/mockcloud/iam/identity-policies', (req, res) => {
    jsonResponse(res, 200, { identityPolicies: store.iam.identityPolicies });
  });

  // Attach a policy document to a principal: { principal, policy }.
  // `policy` is an IAM policy document (object or JSON string).
  app.post('/mockcloud/iam/identity-policies', (req, res) => {
    const { principal, policy } = body(req);
    if (!principal || !policy) return errorJson(res, 400, 'ValidationError', 'principal and policy required');
    (store.iam.identityPolicies[principal] ||= []).push(policy);
    jsonResponse(res, 201, { principal, count: store.iam.identityPolicies[principal].length });
  });

  // Clear all identity policies (or just one principal's via ?principal=).
  app.delete('/mockcloud/iam/identity-policies', (req, res) => {
    const principal = req.query?.principal;
    if (principal) delete store.iam.identityPolicies[principal];
    else store.iam.identityPolicies = {};
    jsonResponse(res, 200, { cleared: principal || 'all' });
  });
}
