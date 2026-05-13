// services/cognito.js — AWS Cognito User Pools emulator
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

function parseBody(req) {
  try { return JSON.parse(req.rawBody || '{}'); } catch { return {}; }
}

const TARGET_MAP = {
  'AWSCognitoIdentityProviderService.CreateUserPool':          createUserPool,
  'AWSCognitoIdentityProviderService.DeleteUserPool':          deleteUserPool,
  'AWSCognitoIdentityProviderService.DescribeUserPool':        describeUserPool,
  'AWSCognitoIdentityProviderService.ListUserPools':           listUserPools,
  'AWSCognitoIdentityProviderService.CreateUserPoolClient':    createUserPoolClient,
  'AWSCognitoIdentityProviderService.ListUserPoolClients':     listUserPoolClients,
  'AWSCognitoIdentityProviderService.DeleteUserPoolClient':    deleteUserPoolClient,
  'AWSCognitoIdentityProviderService.SignUp':                  signUp,
  'AWSCognitoIdentityProviderService.ConfirmSignUp':           confirmSignUp,
  'AWSCognitoIdentityProviderService.InitiateAuth':            initiateAuth,
  'AWSCognitoIdentityProviderService.AdminCreateUser':         adminCreateUser,
  'AWSCognitoIdentityProviderService.AdminDeleteUser':         adminDeleteUser,
  'AWSCognitoIdentityProviderService.AdminGetUser':            adminGetUser,
  'AWSCognitoIdentityProviderService.ListUsers':               listUsers,
  'AWSCognitoIdentityProviderService.AdminSetUserPassword':    (req, res) => jsonResponse(res, 200, {}),
  'AWSCognitoIdentityProviderService.ForgotPassword':          (req, res) => jsonResponse(res, 200, { CodeDeliveryDetails: { DeliveryMedium: 'EMAIL' } }),
  'AWSCognitoIdentityProviderService.ConfirmForgotPassword':   (req, res) => jsonResponse(res, 200, {}),
  'AWSCognitoIdentityProviderService.ChangePassword':          (req, res) => jsonResponse(res, 200, {}),
  'AWSCognitoIdentityProviderService.GetUser':                 getUser,
  'AWSCognitoIdentityProviderService.GlobalSignOut':           (req, res) => jsonResponse(res, 200, {}),
  'AWSCognitoIdentityProviderService.AdminInitiateAuth':       initiateAuth,
  'AWSCognitoIdentityProviderService.RespondToAuthChallenge':  respondToChallenge,
};

export function handler(req, res) {
  const target = req.headers['x-amz-target'] || '';
  const fn = TARGET_MAP[target];
  if (fn) return fn(req, res);
  return errorJson(res, 400, 'InvalidAction', `Unknown Cognito action: ${target}`);
}

function createUserPool(req, res) {
  const b  = parseBody(req);
  const id = `us-east-1_${randomId(9)}`;
  const pool = {
    Id:              id,
    Name:            b.PoolName || 'pool',
    Arn:             arn('cognito-idp', `userpool/${id}`),
    Status:          'Active',
    CreationDate:    Date.now() / 1000,
    LastModifiedDate: Date.now() / 1000,
    users:           {},
    clients:         {},
  };
  store.cognito.userPools[id] = pool;
  store.addTrail({ method: 'POST', path: `/cognito/${b.PoolName}`, status: 200, latency: 5 });
  jsonResponse(res, 200, { UserPool: { Id: pool.Id, Name: pool.Name, Arn: pool.Arn, Status: pool.Status } });
}

function deleteUserPool(req, res) {
  const b = parseBody(req);
  delete store.cognito.userPools[b.UserPoolId];
  jsonResponse(res, 200, {});
}

function describeUserPool(req, res) {
  const b    = parseBody(req);
  const pool = store.cognito.userPools[b.UserPoolId];
  if (!pool) return errorJson(res, 400, 'ResourceNotFoundException', 'User pool not found');
  jsonResponse(res, 200, { UserPool: { ...pool, users: undefined, clients: undefined, EstimatedNumberOfUsers: Object.keys(pool.users).length } });
}

function listUserPools(req, res) {
  jsonResponse(res, 200, {
    UserPools: Object.values(store.cognito.userPools).map(p => ({ Id: p.Id, Name: p.Name, Status: p.Status, CreationDate: p.CreationDate })),
  });
}

function createUserPoolClient(req, res) {
  const b    = parseBody(req);
  const pool = store.cognito.userPools[b.UserPoolId];
  if (!pool) return errorJson(res, 400, 'ResourceNotFoundException', 'User pool not found');
  const clientId = randomId(26);
  pool.clients[clientId] = {
    ClientId:     clientId,
    ClientName:   b.ClientName || 'client',
    UserPoolId:   b.UserPoolId,
    ClientSecret: b.GenerateSecret ? randomId(51) : undefined,
  };
  jsonResponse(res, 200, { UserPoolClient: pool.clients[clientId] });
}

function listUserPoolClients(req, res) {
  const b    = parseBody(req);
  const pool = store.cognito.userPools[b.UserPoolId];
  if (!pool) return errorJson(res, 400, 'ResourceNotFoundException', 'User pool not found');
  jsonResponse(res, 200, { UserPoolClients: Object.values(pool.clients) });
}

function deleteUserPoolClient(req, res) {
  const b    = parseBody(req);
  const pool = store.cognito.userPools[b.UserPoolId];
  if (pool) delete pool.clients[b.ClientId];
  jsonResponse(res, 200, {});
}

function signUp(req, res) {
  const b    = parseBody(req);
  const pool = findPoolByClientId(b.ClientId);
  if (!pool) return errorJson(res, 400, 'ResourceNotFoundException', 'Client not found');
  if (pool.users[b.Username]) return errorJson(res, 400, 'UsernameExistsException', 'User already exists');
  pool.users[b.Username] = {
    Username:   b.Username,
    UserStatus: 'UNCONFIRMED',
    Enabled:    true,
    Attributes: b.UserAttributes || [],
    created:    Date.now(),
  };
  store.addTrail({ method: 'POST', path: '/cognito/signUp', status: 200, latency: 5 });
  jsonResponse(res, 200, { UserConfirmed: false, UserSub: randomId(36) });
}

function confirmSignUp(req, res) {
  const b    = parseBody(req);
  const pool = findPoolByClientId(b.ClientId);
  if (!pool) return errorJson(res, 400, 'ResourceNotFoundException', 'Client not found');
  const user = pool.users[b.Username];
  if (user) user.UserStatus = 'CONFIRMED';
  jsonResponse(res, 200, {});
}

function initiateAuth(req, res) {
  const b    = parseBody(req);
  const pool = findPoolByClientId(b.ClientId || b.UserPoolId);
  const user = pool?.users?.[b.AuthParameters?.USERNAME || b.Username];
  if (!user) return errorJson(res, 400, 'NotAuthorizedException', 'Incorrect username or password');
  const token = Buffer.from(JSON.stringify({ sub: randomId(36), username: user.Username, exp: Date.now() + 3600000 })).toString('base64');
  jsonResponse(res, 200, {
    AuthenticationResult: {
      AccessToken:  `mc.${token}.${randomId(32)}`,
      IdToken:      `mc.${token}.${randomId(32)}`,
      RefreshToken: `mc.refresh.${randomId(64)}`,
      ExpiresIn:    3600,
      TokenType:    'Bearer',
    },
  });
}

function respondToChallenge(req, res) {
  jsonResponse(res, 200, { AuthenticationResult: { AccessToken: `mc.${randomId(64)}`, ExpiresIn: 3600, TokenType: 'Bearer' } });
}

function adminCreateUser(req, res) {
  const b    = parseBody(req);
  const pool = store.cognito.userPools[b.UserPoolId];
  if (!pool) return errorJson(res, 400, 'ResourceNotFoundException', 'User pool not found');
  pool.users[b.Username] = {
    Username: b.Username, UserStatus: 'FORCE_CHANGE_PASSWORD',
    Enabled: true, Attributes: b.UserAttributes || [], created: Date.now(),
  };
  store.addTrail({ method: 'POST', path: `/cognito/${b.UserPoolId}/adminCreateUser`, status: 200, latency: 3 });
  jsonResponse(res, 200, { User: pool.users[b.Username] });
}

function adminDeleteUser(req, res) {
  const b    = parseBody(req);
  const pool = store.cognito.userPools[b.UserPoolId];
  if (pool) delete pool.users[b.Username];
  jsonResponse(res, 200, {});
}

function adminGetUser(req, res) {
  const b    = parseBody(req);
  const pool = store.cognito.userPools[b.UserPoolId];
  const user = pool?.users?.[b.Username];
  if (!user) return errorJson(res, 400, 'UserNotFoundException', 'User not found');
  jsonResponse(res, 200, user);
}

function listUsers(req, res) {
  const b    = parseBody(req);
  const pool = store.cognito.userPools[b.UserPoolId];
  if (!pool) return errorJson(res, 400, 'ResourceNotFoundException', 'User pool not found');
  jsonResponse(res, 200, { Users: Object.values(pool.users) });
}

function getUser(req, res) {
  // AccessToken-based — just return a mock user
  jsonResponse(res, 200, { Username: 'mockuser', UserAttributes: [] });
}

function findPoolByClientId(clientId) {
  for (const pool of Object.values(store.cognito.userPools)) {
    if (pool.clients[clientId]) return pool;
  }
  return null;
}
