// routes/cognito.js — /mockcloud/cognito/* UI API
import { store } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

const body = req => req.parsedBody || {};

export function registerCognitoRoutes(app) {

  app.get('/mockcloud/cognito/userpools', (req, res) => {
    jsonResponse(res, 200, {
      userPools: Object.values(store.cognito.userPools).map(p => ({
        id:          p.Id,
        name:        p.Name,
        arn:         p.Arn,
        status:      p.Status,
        created:     p.CreationDate,
        userCount:   Object.keys(p.users).length,
        clientCount: Object.keys(p.clients).length,
      })),
    });
  });

  app.post('/mockcloud/cognito/userpools', (req, res) => {
    const { name } = body(req);
    if (!name) return errorJson(res, 400, 'ValidationError', 'name required');
    const id = `us-east-1_${Array.from({length:9},()=>'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*62)]).join('')}`;
    store.cognito.userPools[id] = {
      Id: id, Name: name,
      Arn: `arn:aws:cognito-idp:us-east-1:000000000000:userpool/${id}`,
      Status: 'Active',
      CreationDate: Date.now() / 1000,
      LastModifiedDate: Date.now() / 1000,
      users: {}, clients: {},
    };
    store.addTrail({ method: 'POST', path: `/cognito/${name}`, status: 201, latency: 5 });
    jsonResponse(res, 201, { id, name });
  });

  app.get('/mockcloud/cognito/userpools/:id/users', (req, res) => {
    const pool = store.cognito.userPools[req.params.id];
    if (!pool) return errorJson(res, 404, 'NotFound', 'User pool not found');
    jsonResponse(res, 200, { users: Object.values(pool.users) });
  });

  app.post('/mockcloud/cognito/userpools/:id/users', (req, res) => {
    const pool = store.cognito.userPools[req.params.id];
    if (!pool) return errorJson(res, 404, 'NotFound', 'User pool not found');
    const { username, email, attributes } = body(req);
    if (!username) return errorJson(res, 400, 'ValidationError', 'username required');
    if (pool.users[username]) return errorJson(res, 409, 'Conflict', 'User already exists');
    pool.users[username] = {
      Username:        username,
      UserStatus:      'CONFIRMED',
      Enabled:         true,
      UserCreateDate:  Date.now() / 1000,
      UserLastModifiedDate: Date.now() / 1000,
      Attributes: [
        { Name: 'sub',   Value: cryptoUuid() },
        ...(email ? [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }] : []),
        ...Object.entries(attributes || {}).map(([Name, Value]) => ({ Name, Value: String(Value) })),
      ],
    };
    store.addTrail({ method: 'POST', path: `/cognito/${pool.Name}/users/${username}`, status: 201, latency: 3 });
    jsonResponse(res, 201, pool.users[username]);
  });

  app.delete('/mockcloud/cognito/userpools/:id/users/:username', (req, res) => {
    const pool = store.cognito.userPools[req.params.id];
    if (!pool) return errorJson(res, 404, 'NotFound', 'User pool not found');
    if (!pool.users[req.params.username]) return errorJson(res, 404, 'NotFound', 'User not found');
    delete pool.users[req.params.username];
    jsonResponse(res, 200, { deleted: req.params.username });
  });

  app.delete('/mockcloud/cognito/userpools/:id', (req, res) => {
    if (!store.cognito.userPools[req.params.id])
      return errorJson(res, 404, 'NotFound', 'User pool not found');
    delete store.cognito.userPools[req.params.id];
    jsonResponse(res, 200, { deleted: req.params.id });
  });
}

// Generate a UUID-shaped identifier for the cognito 'sub' attribute.
// Uses a small Math.random pad so we don't pull in node:crypto for the UI route.
function cryptoUuid() {
  const r = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
}
