// /mockcloud/iam/* UI routes — port of src/routes/iam.js, including the
// identity-policies endpoints used by the opt-in MOCKCLOUD_IAM evaluation
// (exercised by tests/iam-policy.test.js at M9).
package iam

import (
	"net/http"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
)

func (svc *Service) RegisterUIRoutes(add func(method, pattern string, h func(http.ResponseWriter, *httpapi.Request))) {

	// Users
	add("GET", "/mockcloud/iam/users", func(w http.ResponseWriter, r *httpapi.Request) {
		users := []any{}
		svc.st.With(func(s *state.State) {
			for _, k := range sortedKeys(s.IAM.Users) {
				users = append(users, s.IAM.Users[k])
			}
		})
		respond.JSON(w, 200, map[string]any{"users": users})
	})

	add("POST", "/mockcloud/iam/users", func(w http.ResponseWriter, r *httpapi.Request) {
		nameRaw := normalize(r.ParsedBody["name"])
		if !jsnum.Truthy(nameRaw) {
			respond.ErrorJSON(w, 400, "ValidationError", "name required")
			return
		}
		name := jsnum.ToString(nameRaw)
		policies := normalize(r.ParsedBody["policies"]) // `policies || []`
		if !jsnum.Truthy(policies) {
			policies = []any{}
		}
		var exists bool
		var user map[string]any
		svc.st.With(func(s *state.State) {
			if s.IAM.Users[name] != nil {
				exists = true
				return
			}
			user = map[string]any{
				"name": name, "arn": state.IamArn("user/" + name),
				"created": float64(state.NowMs()), "groups": []any{},
				"policies": policies, "mfa": false, "accessKeys": []any{},
			}
			s.IAM.Users[name] = user
			s.AddTrail(map[string]any{"method": "POST", "path": "/iam/users/" + name, "status": 201, "latency": 3})
		})
		if exists {
			respond.ErrorJSON(w, 409, "Conflict", "User already exists")
			return
		}
		respond.JSON(w, 201, user)
	})

	add("DELETE", "/mockcloud/iam/users/:name", func(w http.ResponseWriter, r *httpapi.Request) {
		name := r.Params["name"]
		svc.st.With(func(s *state.State) {
			delete(s.IAM.Users, name)
			s.AddTrail(map[string]any{"method": "DELETE", "path": "/iam/users/" + name, "status": 200, "latency": 1})
		})
		respond.JSON(w, 200, map[string]any{"deleted": name})
	})

	// Roles
	add("GET", "/mockcloud/iam/roles", func(w http.ResponseWriter, r *httpapi.Request) {
		roles := []any{}
		svc.st.With(func(s *state.State) {
			for _, k := range sortedKeys(s.IAM.Roles) {
				roles = append(roles, s.IAM.Roles[k])
			}
		})
		respond.JSON(w, 200, map[string]any{"roles": roles})
	})

	add("POST", "/mockcloud/iam/roles", func(w http.ResponseWriter, r *httpapi.Request) {
		nameRaw := normalize(r.ParsedBody["name"])
		if !jsnum.Truthy(nameRaw) {
			respond.ErrorJSON(w, 400, "ValidationError", "name required")
			return
		}
		name := jsnum.ToString(nameRaw)
		policies := normalize(r.ParsedBody["policies"]) // `policies || []`
		if !jsnum.Truthy(policies) {
			policies = []any{}
		}
		var exists bool
		var role map[string]any
		svc.st.With(func(s *state.State) {
			if s.IAM.Roles[name] != nil {
				exists = true
				return
			}
			role = map[string]any{
				"name": name, "arn": state.IamArn("role/" + name),
				"created": float64(state.NowMs()), "policies": policies, "attached": float64(0),
			}
			s.IAM.Roles[name] = role
			s.AddTrail(map[string]any{"method": "POST", "path": "/iam/roles/" + name, "status": 201, "latency": 3})
		})
		if exists {
			respond.ErrorJSON(w, 409, "Conflict", "Role already exists")
			return
		}
		respond.JSON(w, 201, role)
	})

	add("DELETE", "/mockcloud/iam/roles/:name", func(w http.ResponseWriter, r *httpapi.Request) {
		name := r.Params["name"]
		svc.st.With(func(s *state.State) {
			delete(s.IAM.Roles, name)
			s.AddTrail(map[string]any{"method": "DELETE", "path": "/iam/roles/" + name, "status": 200, "latency": 1})
		})
		respond.JSON(w, 200, map[string]any{"deleted": name})
	})

	// ── Identity policies (for opt-in MOCKCLOUD_IAM evaluation) ────────────
	add("GET", "/mockcloud/iam/identity-policies", func(w http.ResponseWriter, r *httpapi.Request) {
		var policies map[string]any
		svc.st.With(func(s *state.State) { policies = s.IAM.IdentityPolicies })
		respond.JSON(w, 200, map[string]any{"identityPolicies": policies})
	})

	// Attach a policy document to a principal: { principal, policy }.
	// `policy` is an IAM policy document (object or JSON string).
	add("POST", "/mockcloud/iam/identity-policies", func(w http.ResponseWriter, r *httpapi.Request) {
		principalRaw := normalize(r.ParsedBody["principal"])
		policy := r.ParsedBody["policy"]
		if !jsnum.Truthy(principalRaw) || !jsnum.Truthy(normalize(policy)) {
			respond.ErrorJSON(w, 400, "ValidationError", "principal and policy required")
			return
		}
		principal := jsnum.ToString(principalRaw)
		var count int
		svc.st.With(func(s *state.State) {
			list, _ := s.IAM.IdentityPolicies[principal].([]any)
			list = append(list, policy)
			s.IAM.IdentityPolicies[principal] = list
			count = len(list)
		})
		respond.JSON(w, 201, map[string]any{"principal": principal, "count": count})
	})

	// Clear all identity policies (or just one principal's via ?principal=).
	add("DELETE", "/mockcloud/iam/identity-policies", func(w http.ResponseWriter, r *httpapi.Request) {
		principal := r.Query.Get("principal")
		svc.st.With(func(s *state.State) {
			if principal != "" {
				delete(s.IAM.IdentityPolicies, principal)
			} else {
				s.IAM.IdentityPolicies = map[string]any{}
			}
		})
		cleared := principal
		if cleared == "" {
			cleared = "all"
		}
		respond.JSON(w, 200, map[string]any{"cleared": cleared})
	})
}

// normalize maps json.Number → float64 so jsnum truthiness applies; objects
// and arrays pass through (truthy).
func normalize(v any) any {
	if n, ok := v.(interface{ Float64() (float64, error) }); ok {
		if f, err := n.Float64(); err == nil {
			return f
		}
	}
	return v
}
