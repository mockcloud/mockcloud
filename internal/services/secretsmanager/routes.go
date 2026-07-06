// /mockcloud/secrets* UI routes — port of src/routes/secrets.js.
package secretsmanager

import (
	"net/http"
	"net/url"
	"sort"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
)

// paramName applies Node's decodeURIComponent(req.params.name) — a SECOND
// decode on top of the router's (the Node router already decoded params; the
// secrets routes decode again). A malformed escape surviving to this layer
// throws URIError in Node, which the router catch turns into the 400
// BadRequest shape — reproduced here.
func paramName(w http.ResponseWriter, r *httpapi.Request) (string, bool) {
	name, err := url.PathUnescape(r.Params["name"])
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"__type":"BadRequest","message":"malformed URL parameter"}`))
		return "", false
	}
	return name, true
}

func (svc *Service) RegisterUIRoutes(add func(method, pattern string, h func(http.ResponseWriter, *httpapi.Request))) {

	add("GET", "/mockcloud/secrets", func(w http.ResponseWriter, r *httpapi.Request) {
		secrets := []any{}
		svc.st.With(func(s *state.State) {
			keys := make([]string, 0, len(s.SecretsManager.Secrets))
			for k := range s.SecretsManager.Secrets {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				sec := asMap(s.SecretsManager.Secrets[k])
				if sec == nil {
					continue
				}
				secrets = append(secrets, map[string]any{
					"name":     sec["name"],
					"arn":      sec["arn"],
					"updated":  sec["updated"],
					"rotation": sec["rotation"],
					"versions": sec["versions"],
				})
			}
		})
		respond.JSON(w, 200, map[string]any{"secrets": secrets})
	})

	add("GET", "/mockcloud/secrets/:name", func(w http.ResponseWriter, r *httpapi.Request) {
		name, ok := paramName(w, r)
		if !ok {
			return
		}
		var secret map[string]any
		svc.st.With(func(s *state.State) { secret = asMap(s.SecretsManager.Secrets[name]) })
		if secret == nil {
			respond.ErrorJSON(w, 404, "NotFound", "Secret not found")
			return
		}
		respond.JSON(w, 200, secret)
	})

	add("POST", "/mockcloud/secrets", func(w http.ResponseWriter, r *httpapi.Request) {
		nameRaw := norm(r.ParsedBody["name"])
		valueRaw := norm(r.ParsedBody["value"])
		rotationRaw := norm(r.ParsedBody["rotation"])
		if !jsnum.Truthy(nameRaw) || !jsnum.Truthy(valueRaw) {
			respond.ErrorJSON(w, 400, "ValidationError", "name and value required")
			return
		}
		name := jsnum.ToString(nameRaw)
		rotation := rotationRaw
		if !jsnum.Truthy(rotation) {
			rotation = "never"
		}
		arn := state.Arn("secretsmanager", "secret:"+name)
		var exists bool
		var secret map[string]any
		svc.st.With(func(s *state.State) {
			if s.SecretsManager.Secrets[name] != nil {
				exists = true
				return
			}
			now := float64(state.NowMs())
			secret = map[string]any{
				"name": name, "arn": arn, "value": valueRaw,
				"created": now, "updated": now, "rotation": rotation,
				"versions": []any{map[string]any{"id": "v-1", "stage": "AWSCURRENT", "created": now}},
			}
			s.SecretsManager.Secrets[name] = secret
			s.AddTrail(map[string]any{"method": "POST", "path": "/secretsmanager/" + name, "status": 201, "latency": 4})
		})
		if exists {
			respond.ErrorJSON(w, 409, "Conflict", "Secret already exists")
			return
		}
		respond.JSON(w, 201, secret)
	})

	add("DELETE", "/mockcloud/secrets/:name", func(w http.ResponseWriter, r *httpapi.Request) {
		name, ok := paramName(w, r)
		if !ok {
			return
		}
		var found bool
		svc.st.With(func(s *state.State) {
			if s.SecretsManager.Secrets[name] == nil {
				return
			}
			found = true
			delete(s.SecretsManager.Secrets, name)
			s.AddTrail(map[string]any{"method": "DELETE", "path": "/secretsmanager/" + name, "status": 200, "latency": 1})
		})
		if !found {
			respond.ErrorJSON(w, 404, "NotFound", "Secret not found")
			return
		}
		respond.JSON(w, 200, map[string]any{"deleted": name})
	})
}
