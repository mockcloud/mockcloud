// Package iam — port of src/services/iam.js: the IAM + STS query/XML
// handler (users/roles/policies CRUD, access keys, AssumeRole /
// GetCallerIdentity / GetSessionToken). IAM state is an any-tree
// (map[string]any values) exactly like Node's plain objects.
//
// The May 2026 audit replaced the old fake <UnknownResponse><ok/> stub with
// real errors for unknown actions, and made GetSessionToken validate
// DurationSeconds (NaN used to 500 on toISOString).
package iam

import (
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

type Service struct {
	st *store.Store
}

func New(st *store.Store) *Service { return &Service{st: st} }

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// tmpl — `${v}` template-literal interpolation.
func tmpl(v any) string { return jsnum.ToString(v) }

func esc(v any) string { return respond.EscapeXML(jsnum.ToString(v)) }

// wrap — Node's wrap(respTag, resultTag, inner). Note the https xmlns.
func wrap(respTag, resultTag, inner string) string {
	result := inner
	if resultTag != "" {
		result = "<" + resultTag + ">" + inner + "</" + resultTag + ">"
	}
	return `<?xml version="1.0"?><` + respTag + ` xmlns="https://iam.amazonaws.com/doc/2010-05-08/">` + result +
		`<ResponseMetadata><RequestId>` + state.RandomID(36) + `</RequestId></ResponseMetadata></` + respTag + `>`
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// formVal — params.get(k): present → string, absent → nil (Node's null).
func formVal(params url.Values, key string) any {
	if params.Has(key) {
		return params.Get(key)
	}
	return nil
}

func (svc *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	params, _ := url.ParseQuery(string(r.RawBody))
	action := r.Query.Get("Action")
	if action == "" {
		action = params.Get("Action")
	}

	switch action {
	// ── STS ───────────────────────────────────────────────────────────────
	case "GetCallerIdentity":
		respond.XML(w, 200, wrap("GetCallerIdentityResponse", "GetCallerIdentityResult",
			`<Arn>arn:aws:iam::000000000000:user/local</Arn><UserId>AIDAIOSFODNN7EXAMPLE</UserId><Account>000000000000</Account>`))
	case "AssumeRole":
		roleArn := params.Get("RoleArn")
		if roleArn == "" {
			roleArn = "arn:aws:iam::000000000000:role/default"
		}
		session := params.Get("RoleSessionName")
		if session == "" {
			session = "session"
		}
		respond.XML(w, 200, wrap("AssumeRoleResponse", "AssumeRoleResult",
			`<Credentials><AccessKeyId>ASIAIOSFODNN7EXAMPLE</AccessKeyId><SecretAccessKey>wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY</SecretAccessKey><SessionToken>FQoGZXIvYXdzEJr//fake-session-token</SessionToken><Expiration>`+
				state.ISO(state.NowMs()+3600000)+`</Expiration></Credentials><AssumedRoleUser><Arn>`+
				respond.EscapeXML(roleArn)+`/`+respond.EscapeXML(session)+`</Arn><AssumedRoleId>AROAIOSFODNN7EXAMPLE:`+
				respond.EscapeXML(session)+`</AssumedRoleId></AssumedRoleUser>`))
	case "GetSessionToken":
		// Real STS rejects non-numeric / out-of-range durations with a 400 —
		// without the guard a NaN duration makes toISOString() throw → 500.
		duration := 43200.0
		if params.Has("DurationSeconds") {
			duration = jsnum.ParseIntPrefix(params.Get("DurationSeconds"))
		}
		if math.IsNaN(duration) || math.IsInf(duration, 0) || duration < 900 || duration > 129600 {
			respond.ErrorXML(w, 400, "ValidationError", "DurationSeconds must be between 900 and 129600")
			return
		}
		exp := state.ISO(state.NowMs() + int64(duration*1000))
		respond.XML(w, 200, wrap("GetSessionTokenResponse", "GetSessionTokenResult",
			`<Credentials><AccessKeyId>ASIAIOSFODNN7EXAMPLE</AccessKeyId><SecretAccessKey>wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY</SecretAccessKey><SessionToken>FQoGZXIvYXdzEJr//fake-session-token</SessionToken><Expiration>`+exp+`</Expiration></Credentials>`))

	// ── Users ─────────────────────────────────────────────────────────────
	case "CreateUser":
		name := params.Get("UserName")
		var exists bool
		var arn string
		svc.st.With(func(s *state.State) {
			if s.IAM.Users[name] != nil {
				exists = true
				return
			}
			arn = state.IamArn("user/" + name)
			s.IAM.Users[name] = map[string]any{
				"name": name, "arn": arn, "created": float64(state.NowMs()),
				"groups": []any{}, "policies": []any{}, "mfa": false, "accessKeys": []any{},
			}
			s.AddTrail(map[string]any{"method": "POST", "path": "/iam/CreateUser/" + name, "status": 200, "latency": 2})
		})
		if exists {
			respond.ErrorXML(w, 409, "EntityAlreadyExists", "User "+name+" already exists")
			return
		}
		respond.XML(w, 200, wrap("CreateUserResponse", "CreateUserResult",
			"<User><UserName>"+respond.EscapeXML(name)+"</UserName><Arn>"+respond.EscapeXML(arn)+"</Arn><UserId>"+strings.ToUpper(state.RandomID(20))+"</UserId></User>"))
	case "GetUser":
		name := params.Get("UserName")
		if name == "" {
			name = "local"
		}
		var u map[string]any
		svc.st.With(func(s *state.State) { u = asMap(s.IAM.Users[name]) })
		if u == nil {
			respond.ErrorXML(w, 404, "NoSuchEntity", "User "+name+" not found")
			return
		}
		respond.XML(w, 200, wrap("GetUserResponse", "GetUserResult",
			"<User><UserName>"+esc(u["name"])+"</UserName><Arn>"+esc(u["arn"])+"</Arn></User>"))
	case "DeleteUser":
		name := params.Get("UserName")
		svc.st.With(func(s *state.State) {
			delete(s.IAM.Users, name)
			s.AddTrail(map[string]any{"method": "POST", "path": "/iam/DeleteUser/" + name, "status": 200, "latency": 1})
		})
		respond.XML(w, 200, wrap("DeleteUserResponse", "DeleteUserResult", ""))
	case "ListUsers":
		var users strings.Builder
		svc.st.With(func(s *state.State) {
			for _, k := range sortedKeys(s.IAM.Users) {
				u := asMap(s.IAM.Users[k])
				if u == nil {
					continue
				}
				users.WriteString("<member><UserName>" + esc(u["name"]) + "</UserName><Arn>" + esc(u["arn"]) + "</Arn></member>")
			}
		})
		respond.XML(w, 200, wrap("ListUsersResponse", "ListUsersResult", "<Users>"+users.String()+"</Users>"))

	// ── Roles ─────────────────────────────────────────────────────────────
	case "CreateRole":
		name := params.Get("RoleName")
		var exists bool
		var role map[string]any
		svc.st.With(func(s *state.State) {
			if s.IAM.Roles[name] != nil {
				exists = true
				return
			}
			path := params.Get("Path")
			if path == "" {
				path = "/"
			}
			role = map[string]any{
				"name": name, "arn": state.IamArn("role/" + name),
				"roleId": "AROA" + strings.ToUpper(state.RandomID(16)),
				"path":   path, "created": float64(state.NowMs()),
				"policies": []any{}, "trustPolicy": formVal(params, "AssumeRolePolicyDocument"),
				"attached": float64(0),
			}
			s.IAM.Roles[name] = role
			s.AddTrail(map[string]any{"method": "POST", "path": "/iam/CreateRole/" + name, "status": 200, "latency": 2})
		})
		if exists {
			respond.ErrorXML(w, 409, "EntityAlreadyExists", "Role "+name+" already exists")
			return
		}
		respond.XML(w, 200, wrap("CreateRoleResponse", "CreateRoleResult", roleXML(role)))
	case "GetRole":
		name := params.Get("RoleName")
		var role map[string]any
		svc.st.With(func(s *state.State) { role = asMap(s.IAM.Roles[name]) })
		if role == nil {
			respond.ErrorXML(w, 404, "NoSuchEntity", "Role "+name+" not found")
			return
		}
		respond.XML(w, 200, wrap("GetRoleResponse", "GetRoleResult", roleXML(role)))
	case "DeleteRole":
		name := params.Get("RoleName")
		svc.st.With(func(s *state.State) {
			delete(s.IAM.Roles, name)
			s.AddTrail(map[string]any{"method": "POST", "path": "/iam/DeleteRole/" + name, "status": 200, "latency": 1})
		})
		respond.XML(w, 200, wrap("DeleteRoleResponse", "DeleteRoleResult", ""))
	case "ListRoles":
		var roles strings.Builder
		svc.st.With(func(s *state.State) {
			for _, k := range sortedKeys(s.IAM.Roles) {
				r := asMap(s.IAM.Roles[k])
				if r == nil {
					continue
				}
				roles.WriteString("<member><RoleName>" + esc(r["name"]) + "</RoleName><Arn>" + esc(r["arn"]) + "</Arn></member>")
			}
		})
		respond.XML(w, 200, wrap("ListRolesResponse", "ListRolesResult", "<Roles>"+roles.String()+"</Roles>"))
	case "ListRolePolicies":
		var members strings.Builder
		svc.st.With(func(s *state.State) {
			role := asMap(s.IAM.Roles[params.Get("RoleName")])
			if role == nil {
				return
			}
			inline := asMap(role["inlinePolicies"])
			for _, n := range sortedKeys(inline) {
				members.WriteString("<member>" + respond.EscapeXML(n) + "</member>")
			}
		})
		respond.XML(w, 200, wrap("ListRolePoliciesResponse", "ListRolePoliciesResult",
			"<PolicyNames>"+members.String()+"</PolicyNames><IsTruncated>false</IsTruncated>"))
	case "ListAttachedRolePolicies":
		respond.XML(w, 200, wrap("ListAttachedRolePoliciesResponse", "ListAttachedRolePoliciesResult",
			"<AttachedPolicies></AttachedPolicies><IsTruncated>false</IsTruncated>"))
	case "ListRoleTags":
		respond.XML(w, 200, wrap("ListRoleTagsResponse", "ListRoleTagsResult",
			"<Tags></Tags><IsTruncated>false</IsTruncated>"))
	case "ListInstanceProfilesForRole":
		respond.XML(w, 200, wrap("ListInstanceProfilesForRoleResponse", "ListInstanceProfilesForRoleResult",
			"<InstanceProfiles></InstanceProfiles><IsTruncated>false</IsTruncated>"))
	case "AttachRolePolicy":
		name := params.Get("RoleName")
		var found bool
		svc.st.With(func(s *state.State) {
			role := asMap(s.IAM.Roles[name])
			if role == nil {
				return
			}
			found = true
			policyArn := formVal(params, "PolicyArn")
			policies, _ := role["policies"].([]any)
			has := false
			for _, p := range policies {
				if jsnum.StrictEq(p, policyArn) {
					has = true
					break
				}
			}
			if !has {
				role["policies"] = append(policies, policyArn)
			}
			s.AddTrail(map[string]any{"method": "POST", "path": "/iam/AttachRolePolicy/" + name, "status": 200, "latency": 1})
		})
		if !found {
			respond.ErrorXML(w, 404, "NoSuchEntity", "Role "+name+" not found")
			return
		}
		respond.XML(w, 200, wrap("AttachRolePolicyResponse", "", ""))
	case "DetachRolePolicy":
		name := params.Get("RoleName")
		svc.st.With(func(s *state.State) {
			if role := asMap(s.IAM.Roles[name]); role != nil {
				policyArn := formVal(params, "PolicyArn")
				kept := []any{}
				for _, p := range asSlice(role["policies"]) {
					if !jsnum.StrictEq(p, policyArn) {
						kept = append(kept, p)
					}
				}
				role["policies"] = kept
			}
			s.AddTrail(map[string]any{"method": "POST", "path": "/iam/DetachRolePolicy/" + name, "status": 200, "latency": 1})
		})
		respond.XML(w, 200, wrap("DetachRolePolicyResponse", "", ""))
	case "CreatePolicy":
		name := params.Get("PolicyName")
		if name == "" {
			respond.ErrorXML(w, 400, "ValidationError", "PolicyName is required")
			return
		}
		var exists bool
		var arn, policyID, now string
		var path string
		svc.st.With(func(s *state.State) {
			if s.IAM.Policies[name] != nil {
				exists = true
				return
			}
			path = params.Get("Path")
			if path == "" {
				path = "/"
			}
			arn = state.IamArn("policy" + path + name)
			policyID = "ANPA" + strings.ToUpper(state.RandomID(16))
			now = state.ISO(state.NowMs())
			s.IAM.Policies[name] = map[string]any{
				"name": name, "arn": arn, "policyId": policyID, "path": path,
				"document": formVal(params, "PolicyDocument"), "created": float64(state.NowMs()),
			}
			s.AddTrail(map[string]any{"method": "POST", "path": "/iam/CreatePolicy/" + name, "status": 200, "latency": 2})
		})
		if exists {
			respond.ErrorXML(w, 409, "EntityAlreadyExists", "Policy "+name+" already exists")
			return
		}
		respond.XML(w, 200, wrap("CreatePolicyResponse", "CreatePolicyResult",
			"<Policy><PolicyName>"+respond.EscapeXML(name)+"</PolicyName><PolicyId>"+policyID+"</PolicyId><Arn>"+
				respond.EscapeXML(arn)+"</Arn><Path>"+respond.EscapeXML(path)+"</Path><DefaultVersionId>v1</DefaultVersionId><AttachmentCount>0</AttachmentCount><IsAttachable>true</IsAttachable><CreateDate>"+
				now+"</CreateDate><UpdateDate>"+now+"</UpdateDate></Policy>"))
	case "PutRolePolicy":
		name := params.Get("RoleName")
		policyName := params.Get("PolicyName")
		var found bool
		svc.st.With(func(s *state.State) {
			role := asMap(s.IAM.Roles[name])
			if role == nil {
				return
			}
			found = true
			if policyName == "" {
				return
			}
			inline := asMap(role["inlinePolicies"])
			if inline == nil {
				inline = map[string]any{}
				role["inlinePolicies"] = inline
			}
			inline[policyName] = params.Get("PolicyDocument") // `|| ''` — Get gives "" for absent
			s.AddTrail(map[string]any{"method": "POST", "path": "/iam/PutRolePolicy/" + name, "status": 200, "latency": 1})
		})
		if !found {
			respond.ErrorXML(w, 404, "NoSuchEntity", "Role "+name+" not found")
			return
		}
		if policyName == "" {
			respond.ErrorXML(w, 400, "ValidationError", "PolicyName is required")
			return
		}
		respond.XML(w, 200, wrap("PutRolePolicyResponse", "", ""))
	case "DeleteRolePolicy":
		name := params.Get("RoleName")
		svc.st.With(func(s *state.State) {
			if role := asMap(s.IAM.Roles[name]); role != nil {
				if inline := asMap(role["inlinePolicies"]); inline != nil {
					delete(inline, params.Get("PolicyName"))
				}
			}
			s.AddTrail(map[string]any{"method": "POST", "path": "/iam/DeleteRolePolicy/" + name, "status": 200, "latency": 1})
		})
		respond.XML(w, 200, wrap("DeleteRolePolicyResponse", "", ""))
	case "CreateAccessKey":
		userName := params.Get("UserName")
		accessKeyID := "AKIA" + strings.ToUpper(state.RandomID(16))
		secret := state.RandomID(40)
		svc.st.With(func(s *state.State) {
			key := map[string]any{
				"AccessKeyId": accessKeyID, "SecretAccessKey": secret,
				"Status": "Active", "Created": float64(state.NowMs()),
			}
			if user := asMap(s.IAM.Users[userName]); user != nil {
				keys, _ := user["accessKeys"].([]any)
				user["accessKeys"] = append(keys, key)
			}
			// Register the credential so opt-in SigV4 verification can
			// validate it.
			s.IAM.AccessKeys[accessKeyID] = secret
			if userName != "" {
				if s.IAM.AccessKeyOwners == nil {
					s.IAM.AccessKeyOwners = map[string]string{}
				}
				s.IAM.AccessKeyOwners[accessKeyID] = userName
			}
		})
		respond.XML(w, 200, wrap("CreateAccessKeyResponse", "CreateAccessKeyResult",
			"<AccessKey><UserName>"+respond.EscapeXML(userName)+"</UserName><AccessKeyId>"+accessKeyID+
				"</AccessKeyId><SecretAccessKey>"+secret+"</SecretAccessKey><Status>Active</Status></AccessKey>"))

	default:
		// Don't fake a 200 success for actions we don't implement — that
		// silently breaks IaC (e.g. Terraform thinks a policy attached when it
		// didn't).
		if action == "" {
			action = "(none)"
		}
		respond.ErrorXML(w, 400, "InvalidAction", "Unsupported IAM/STS action: "+action)
	}
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

func roleXML(r map[string]any) string {
	trust := ""
	if jsnum.Truthy(r["trustPolicy"]) {
		trust = esc(r["trustPolicy"])
	}
	created := state.ISO(int64(jsnum.ToNumber(r["created"])))
	roleID := "AROA0000000000000000"
	if jsnum.Truthy(r["roleId"]) {
		roleID = jsnum.ToString(r["roleId"])
	}
	path := "/"
	if jsnum.Truthy(r["path"]) {
		path = jsnum.ToString(r["path"])
	}
	return "<Role>" +
		"<RoleName>" + esc(r["name"]) + "</RoleName>" +
		"<RoleId>" + respond.EscapeXML(roleID) + "</RoleId>" +
		"<Arn>" + esc(r["arn"]) + "</Arn>" +
		"<Path>" + respond.EscapeXML(path) + "</Path>" +
		"<CreateDate>" + created + "</CreateDate>" +
		"<AssumeRolePolicyDocument>" + trust + "</AssumeRolePolicyDocument>" +
		"<MaxSessionDuration>3600</MaxSessionDuration>" +
		"<RoleLastUsed></RoleLastUsed>" +
		"</Role>"
}
