// services/iam.js
import { store, randomId, arn } from '../store.js';
import { xmlResponse, errorXml, escapeXml, getRawBody } from '../middleware/response.js';

export async function handler(req, res) {
  const body = getRawBody(req);
  const params = new URLSearchParams(body);
  const action = new URL(req.url,'http://x').searchParams.get('Action') || params.get('Action');

  switch (action) {
    // ── STS ───────────────────────────────────────────────────────────────
    case 'GetCallerIdentity':
      return xmlResponse(res, 200, wrap('GetCallerIdentityResponse','GetCallerIdentityResult',
        `<Arn>arn:aws:iam::000000000000:user/local</Arn><UserId>AIDAIOSFODNN7EXAMPLE</UserId><Account>000000000000</Account>`));
    case 'AssumeRole': {
      const roleArn = params.get('RoleArn') || 'arn:aws:iam::000000000000:role/default';
      const session = params.get('RoleSessionName') || 'session';
      return xmlResponse(res, 200, wrap('AssumeRoleResponse','AssumeRoleResult',
        `<Credentials><AccessKeyId>ASIAIOSFODNN7EXAMPLE</AccessKeyId><SecretAccessKey>wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY</SecretAccessKey><SessionToken>FQoGZXIvYXdzEJr//fake-session-token</SessionToken><Expiration>${new Date(Date.now()+3600000).toISOString()}</Expiration></Credentials><AssumedRoleUser><Arn>${escapeXml(roleArn)}/${escapeXml(session)}</Arn><AssumedRoleId>AROAIOSFODNN7EXAMPLE:${escapeXml(session)}</AssumedRoleId></AssumedRoleUser>`));
    }

    // ── Users ─────────────────────────────────────────────────────────────
    case 'CreateUser': {
      const name = params.get('UserName');
      if (store.iam.users[name]) return errorXml(res, 409, 'EntityAlreadyExists', `User ${name} already exists`);
      store.iam.users[name] = { name, arn: arn('iam',`user/${name}`), created: Date.now(), groups:[], policies:[], mfa:false, accessKeys:[] };
      return xmlResponse(res, 200, wrap('CreateUserResponse','CreateUserResult', `<User><UserName>${escapeXml(name)}</UserName><Arn>${escapeXml(store.iam.users[name].arn)}</Arn><UserId>${randomId(20).toUpperCase()}</UserId></User>`));
    }
    case 'GetUser': {
      const name = params.get('UserName') || 'local';
      const u = store.iam.users[name];
      if (!u) return errorXml(res, 404, 'NoSuchEntity', `User ${name} not found`);
      return xmlResponse(res, 200, wrap('GetUserResponse','GetUserResult', `<User><UserName>${escapeXml(u.name)}</UserName><Arn>${escapeXml(u.arn)}</Arn></User>`));
    }
    case 'DeleteUser': {
      delete store.iam.users[params.get('UserName')];
      return xmlResponse(res, 200, wrap('DeleteUserResponse','DeleteUserResult',''));
    }
    case 'ListUsers': {
      const users = Object.values(store.iam.users).map(u=>`<member><UserName>${escapeXml(u.name)}</UserName><Arn>${escapeXml(u.arn)}</Arn></member>`).join('');
      return xmlResponse(res, 200, wrap('ListUsersResponse','ListUsersResult', `<Users>${users}</Users>`));
    }

    // ── Roles ─────────────────────────────────────────────────────────────
    case 'CreateRole': {
      const name = params.get('RoleName');
      if (store.iam.roles[name]) return errorXml(res, 409, 'EntityAlreadyExists', `Role ${name} already exists`);
      const a = arn('iam', `role/${name}`);
      const roleId = 'AROA' + randomId(16).toUpperCase();
      store.iam.roles[name] = { name, arn: a, roleId, path: params.get('Path') || '/', created: Date.now(), policies:[], trustPolicy: params.get('AssumeRolePolicyDocument'), attached: 0 };
      return xmlResponse(res, 200, wrap('CreateRoleResponse','CreateRoleResult', roleXml(store.iam.roles[name])));
    }
    case 'GetRole': {
      const name = params.get('RoleName');
      const r = store.iam.roles[name];
      if (!r) return errorXml(res, 404, 'NoSuchEntity', `Role ${name} not found`);
      return xmlResponse(res, 200, wrap('GetRoleResponse','GetRoleResult', roleXml(r)));
    }
    case 'DeleteRole': {
      delete store.iam.roles[params.get('RoleName')];
      return xmlResponse(res, 200, wrap('DeleteRoleResponse','DeleteRoleResult',''));
    }
    case 'ListRoles': {
      const roles = Object.values(store.iam.roles).map(r=>`<member><RoleName>${escapeXml(r.name)}</RoleName><Arn>${escapeXml(r.arn)}</Arn></member>`).join('');
      return xmlResponse(res, 200, wrap('ListRolesResponse','ListRolesResult', `<Roles>${roles}</Roles>`));
    }
    case 'ListRolePolicies': {
      return xmlResponse(res, 200, wrap('ListRolePoliciesResponse','ListRolePoliciesResult', `<PolicyNames></PolicyNames><IsTruncated>false</IsTruncated>`));
    }
    case 'ListAttachedRolePolicies': {
      return xmlResponse(res, 200, wrap('ListAttachedRolePoliciesResponse','ListAttachedRolePoliciesResult', `<AttachedPolicies></AttachedPolicies><IsTruncated>false</IsTruncated>`));
    }
    case 'ListRoleTags': {
      return xmlResponse(res, 200, wrap('ListRoleTagsResponse','ListRoleTagsResult', `<Tags></Tags><IsTruncated>false</IsTruncated>`));
    }
    case 'ListInstanceProfilesForRole': {
      return xmlResponse(res, 200, wrap('ListInstanceProfilesForRoleResponse','ListInstanceProfilesForRoleResult', `<InstanceProfiles></InstanceProfiles><IsTruncated>false</IsTruncated>`));
    }
    case 'AttachRolePolicy': {
      const name = params.get('RoleName');
      const role = store.iam.roles[name];
      if (!role) return errorXml(res, 404, 'NoSuchEntity', `Role ${name} not found`);
      const policyArn = params.get('PolicyArn');
      if (!role.policies.includes(policyArn)) role.policies.push(policyArn);
      return xmlResponse(res, 200, wrap('AttachRolePolicyResponse','','')); 
    }
    case 'DetachRolePolicy': {
      const role = store.iam.roles[params.get('RoleName')];
      if (role) role.policies = role.policies.filter(p => p !== params.get('PolicyArn'));
      return xmlResponse(res, 200, wrap('DetachRolePolicyResponse','',''));
    }
    case 'CreateAccessKey': {
      const user = store.iam.users[params.get('UserName')];
      const key = { AccessKeyId: 'AKIA'+randomId(16).toUpperCase(), SecretAccessKey: randomId(40), Status: 'Active', Created: Date.now() };
      if (user) user.accessKeys.push(key);
      return xmlResponse(res, 200, wrap('CreateAccessKeyResponse','CreateAccessKeyResult', `<AccessKey><AccessKeyId>${key.AccessKeyId}</AccessKeyId><SecretAccessKey>${key.SecretAccessKey}</SecretAccessKey><Status>Active</Status></AccessKey>`));
    }

    default:
      return xmlResponse(res, 200, wrap('UnknownResponse','Result','<ok/>'));
  }
}

function roleXml(r) {
  const trust = r.trustPolicy ? escapeXml(r.trustPolicy) : '';
  const created = new Date(r.created).toISOString();
  return `<Role>` +
    `<RoleName>${escapeXml(r.name)}</RoleName>` +
    `<RoleId>${escapeXml(r.roleId || 'AROA0000000000000000')}</RoleId>` +
    `<Arn>${escapeXml(r.arn)}</Arn>` +
    `<Path>${escapeXml(r.path || '/')}</Path>` +
    `<CreateDate>${created}</CreateDate>` +
    `<AssumeRolePolicyDocument>${trust}</AssumeRolePolicyDocument>` +
    `<MaxSessionDuration>3600</MaxSessionDuration>` +
    `<RoleLastUsed></RoleLastUsed>` +
    `</Role>`;
}

function wrap(respTag, resultTag, inner) {
  const result = resultTag ? `<${resultTag}>${inner}</${resultTag}>` : inner;
  return `<?xml version="1.0"?><${respTag} xmlns="https://iam.amazonaws.com/doc/2010-05-08/">${result}<ResponseMetadata><RequestId>${randomId(36)}</RequestId></ResponseMetadata></${respTag}>`;
}
