// services/iam.js
import { store, randomId, iamArn } from '../store.js';
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
    case 'GetSessionToken': {
      // Real STS rejects non-numeric / out-of-range durations with a 400 —
      // without the guard a NaN duration makes toISOString() throw → 500.
      const raw = params.get('DurationSeconds');
      const duration = raw === null ? 43200 : Number.parseInt(raw, 10);
      if (!Number.isFinite(duration) || duration < 900 || duration > 129600)
        return errorXml(res, 400, 'ValidationError', 'DurationSeconds must be between 900 and 129600');
      const exp = new Date(Date.now() + duration * 1000).toISOString();
      return xmlResponse(res, 200, wrap('GetSessionTokenResponse','GetSessionTokenResult',
        `<Credentials><AccessKeyId>ASIAIOSFODNN7EXAMPLE</AccessKeyId><SecretAccessKey>wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY</SecretAccessKey><SessionToken>FQoGZXIvYXdzEJr//fake-session-token</SessionToken><Expiration>${exp}</Expiration></Credentials>`));
    }

    // ── Users ─────────────────────────────────────────────────────────────
    case 'CreateUser': {
      const name = params.get('UserName');
      if (store.iam.users[name]) return errorXml(res, 409, 'EntityAlreadyExists', `User ${name} already exists`);
      store.iam.users[name] = { name, arn: iamArn(`user/${name}`), created: Date.now(), groups:[], policies:[], mfa:false, accessKeys:[] };
      store.addTrail({ method: 'POST', path: `/iam/CreateUser/${name}`, status: 200, latency: 2 });
      return xmlResponse(res, 200, wrap('CreateUserResponse','CreateUserResult', `<User><UserName>${escapeXml(name)}</UserName><Arn>${escapeXml(store.iam.users[name].arn)}</Arn><UserId>${randomId(20).toUpperCase()}</UserId></User>`));
    }
    case 'GetUser': {
      const name = params.get('UserName') || 'local';
      const u = store.iam.users[name];
      if (!u) return errorXml(res, 404, 'NoSuchEntity', `User ${name} not found`);
      return xmlResponse(res, 200, wrap('GetUserResponse','GetUserResult', `<User><UserName>${escapeXml(u.name)}</UserName><Arn>${escapeXml(u.arn)}</Arn></User>`));
    }
    case 'DeleteUser': {
      const name = params.get('UserName');
      delete store.iam.users[name];
      store.addTrail({ method: 'POST', path: `/iam/DeleteUser/${name}`, status: 200, latency: 1 });
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
      const a = iamArn(`role/${name}`);
      const roleId = 'AROA' + randomId(16).toUpperCase();
      store.iam.roles[name] = { name, arn: a, roleId, path: params.get('Path') || '/', created: Date.now(), policies:[], trustPolicy: params.get('AssumeRolePolicyDocument'), attached: 0 };
      store.addTrail({ method: 'POST', path: `/iam/CreateRole/${name}`, status: 200, latency: 2 });
      return xmlResponse(res, 200, wrap('CreateRoleResponse','CreateRoleResult', roleXml(store.iam.roles[name])));
    }
    case 'GetRole': {
      const name = params.get('RoleName');
      const r = store.iam.roles[name];
      if (!r) return errorXml(res, 404, 'NoSuchEntity', `Role ${name} not found`);
      return xmlResponse(res, 200, wrap('GetRoleResponse','GetRoleResult', roleXml(r)));
    }
    case 'DeleteRole': {
      const name = params.get('RoleName');
      delete store.iam.roles[name];
      store.addTrail({ method: 'POST', path: `/iam/DeleteRole/${name}`, status: 200, latency: 1 });
      return xmlResponse(res, 200, wrap('DeleteRoleResponse','DeleteRoleResult',''));
    }
    case 'ListRoles': {
      const roles = Object.values(store.iam.roles).map(r=>`<member><RoleName>${escapeXml(r.name)}</RoleName><Arn>${escapeXml(r.arn)}</Arn></member>`).join('');
      return xmlResponse(res, 200, wrap('ListRolesResponse','ListRolesResult', `<Roles>${roles}</Roles>`));
    }
    case 'ListRolePolicies': {
      const role = store.iam.roles[params.get('RoleName')];
      const names = role?.inlinePolicies ? Object.keys(role.inlinePolicies) : [];
      const members = names.map(n => `<member>${escapeXml(n)}</member>`).join('');
      return xmlResponse(res, 200, wrap('ListRolePoliciesResponse','ListRolePoliciesResult', `<PolicyNames>${members}</PolicyNames><IsTruncated>false</IsTruncated>`));
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
      store.addTrail({ method: 'POST', path: `/iam/AttachRolePolicy/${name}`, status: 200, latency: 1 });
      return xmlResponse(res, 200, wrap('AttachRolePolicyResponse','',''));
    }
    case 'DetachRolePolicy': {
      const name = params.get('RoleName');
      const role = store.iam.roles[name];
      if (role) role.policies = role.policies.filter(p => p !== params.get('PolicyArn'));
      store.addTrail({ method: 'POST', path: `/iam/DetachRolePolicy/${name}`, status: 200, latency: 1 });
      return xmlResponse(res, 200, wrap('DetachRolePolicyResponse','',''));
    }
    case 'CreatePolicy': {
      const name = params.get('PolicyName');
      if (!name) return errorXml(res, 400, 'ValidationError', 'PolicyName is required');
      if (store.iam.policies[name]) return errorXml(res, 409, 'EntityAlreadyExists', `Policy ${name} already exists`);
      const path = params.get('Path') || '/';
      const a = iamArn(`policy${path}${name}`);
      const policyId = 'ANPA' + randomId(16).toUpperCase();
      const now = new Date().toISOString();
      store.iam.policies[name] = { name, arn: a, policyId, path, document: params.get('PolicyDocument'), created: Date.now() };
      store.addTrail({ method: 'POST', path: `/iam/CreatePolicy/${name}`, status: 200, latency: 2 });
      return xmlResponse(res, 200, wrap('CreatePolicyResponse','CreatePolicyResult',
        `<Policy><PolicyName>${escapeXml(name)}</PolicyName><PolicyId>${policyId}</PolicyId><Arn>${escapeXml(a)}</Arn><Path>${escapeXml(path)}</Path><DefaultVersionId>v1</DefaultVersionId><AttachmentCount>0</AttachmentCount><IsAttachable>true</IsAttachable><CreateDate>${now}</CreateDate><UpdateDate>${now}</UpdateDate></Policy>`));
    }
    case 'PutRolePolicy': {
      const name = params.get('RoleName');
      const role = store.iam.roles[name];
      if (!role) return errorXml(res, 404, 'NoSuchEntity', `Role ${name} not found`);
      const policyName = params.get('PolicyName');
      if (!policyName) return errorXml(res, 400, 'ValidationError', 'PolicyName is required');
      role.inlinePolicies = role.inlinePolicies || {};
      role.inlinePolicies[policyName] = params.get('PolicyDocument') || '';
      store.addTrail({ method: 'POST', path: `/iam/PutRolePolicy/${name}`, status: 200, latency: 1 });
      return xmlResponse(res, 200, wrap('PutRolePolicyResponse','',''));
    }
    case 'DeleteRolePolicy': {
      const name = params.get('RoleName');
      const role = store.iam.roles[name];
      if (role?.inlinePolicies) delete role.inlinePolicies[params.get('PolicyName')];
      store.addTrail({ method: 'POST', path: `/iam/DeleteRolePolicy/${name}`, status: 200, latency: 1 });
      return xmlResponse(res, 200, wrap('DeleteRolePolicyResponse','',''));
    }
    case 'CreateAccessKey': {
      const userName = params.get('UserName');
      const user = store.iam.users[userName];
      const key = { AccessKeyId: 'AKIA'+randomId(16).toUpperCase(), SecretAccessKey: randomId(40), Status: 'Active', Created: Date.now() };
      if (user) user.accessKeys.push(key);
      // Register the credential so opt-in SigV4 verification can validate it.
      store.iam.accessKeys[key.AccessKeyId] = key.SecretAccessKey;
      if (userName) store.iam.accessKeyOwners = { ...(store.iam.accessKeyOwners || {}), [key.AccessKeyId]: userName };
      return xmlResponse(res, 200, wrap('CreateAccessKeyResponse','CreateAccessKeyResult', `<AccessKey><UserName>${escapeXml(userName||'')}</UserName><AccessKeyId>${key.AccessKeyId}</AccessKeyId><SecretAccessKey>${key.SecretAccessKey}</SecretAccessKey><Status>Active</Status></AccessKey>`));
    }

    default:
      // Don't fake a 200 success for actions we don't implement — that silently
      // breaks IaC (e.g. Terraform thinks a policy attached when it didn't).
      return errorXml(res, 400, 'InvalidAction', `Unsupported IAM/STS action: ${action || '(none)'}`);
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
