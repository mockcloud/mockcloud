// Package secretsmanager — port of src/services/secretsmanager.js: the JSON
// protocol handler (x-amz-target `secretsmanager.*`) for Create/Get/Put/
// Delete/List/Describe secrets. Secrets state is an any-tree
// (map[string]any values) exactly like Node's plain objects.
package secretsmanager

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
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

// norm — json.Number → float64 so JS truthiness/coercions apply.
func norm(v any) any {
	if n, ok := v.(json.Number); ok {
		if f, err := n.Float64(); err == nil {
			return f
		}
		return jsnum.ToNumberFromString(n.String())
	}
	return v
}

// keyOf — JS object-key coercion for payload.SecretId / payload.Name.
func keyOf(v any) string {
	if v == nil {
		return "undefined" // store.secrets[undefined] — never matches anything real
	}
	return jsnum.ToString(norm(v))
}

func (svc *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	target := r.Header.Get("x-amz-target")
	op := target
	if i := strings.LastIndex(target, "."); i >= 0 {
		op = target[i+1:]
	}
	payload := r.JSONBody()

	switch op {
	case "CreateSecret":
		svc.createSecret(w, payload)
	case "GetSecretValue":
		svc.getSecretValue(w, payload)
	case "PutSecretValue":
		svc.putSecretValue(w, payload)
	case "DeleteSecret":
		svc.deleteSecret(w, payload)
	case "ListSecrets":
		svc.listSecrets(w)
	case "DescribeSecret":
		svc.describeSecret(w, payload)
	default:
		respond.ErrorJSON(w, 400, "UnknownOperationException", "Unknown SM operation: "+op)
	}
}

func (svc *Service) createSecret(w http.ResponseWriter, payload map[string]any) {
	nameRaw := norm(payload["Name"])
	if !jsnum.Truthy(nameRaw) {
		respond.ErrorJSON(w, 400, "ValidationException", "Name required")
		return
	}
	name := jsnum.ToString(nameRaw)
	// value = payload.SecretString || payload.SecretBinary || ''
	value := norm(payload["SecretString"])
	if !jsnum.Truthy(value) {
		value = norm(payload["SecretBinary"])
	}
	if !jsnum.Truthy(value) {
		value = ""
	}
	arn := state.Arn("secretsmanager", "secret:"+name)
	var exists bool
	svc.st.With(func(s *state.State) {
		if s.SecretsManager.Secrets[name] != nil {
			exists = true
			return
		}
		now := float64(state.NowMs())
		s.SecretsManager.Secrets[name] = map[string]any{
			"name": name, "arn": arn, "value": value,
			"created": now, "updated": now, "rotation": "never",
			"versions": []any{map[string]any{"id": "v-1", "stage": "AWSCURRENT", "created": now}},
		}
	})
	if exists {
		respond.ErrorJSON(w, 400, "ResourceExistsException", "Secret already exists: "+name)
		return
	}
	respond.JSON(w, 200, map[string]any{"ARN": arn, "Name": name, "VersionId": "v-1"})
}

func (svc *Service) getSecretValue(w http.ResponseWriter, payload map[string]any) {
	id := keyOf(payload["SecretId"])
	var secret map[string]any
	svc.st.With(func(s *state.State) { secret = asMap(s.SecretsManager.Secrets[id]) })
	if secret == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Secret not found: "+id)
		return
	}
	respond.JSON(w, 200, map[string]any{
		"ARN": secret["arn"], "Name": secret["name"], "SecretString": secret["value"],
		"CreatedDate": jsnum.ToNumber(secret["created"]) / 1000, "VersionId": "v-1",
	})
}

func (svc *Service) putSecretValue(w http.ResponseWriter, payload map[string]any) {
	id := keyOf(payload["SecretId"])
	var secret map[string]any
	var newVerID string
	svc.st.With(func(s *state.State) {
		secret = asMap(s.SecretsManager.Secrets[id])
		if secret == nil {
			return
		}
		versions, _ := secret["versions"].([]any)
		if len(versions) > 0 {
			if oldVersion := asMap(versions[0]); oldVersion != nil {
				oldVersion["stage"] = "AWSPREVIOUS"
			}
		}
		// secret.value = payload.SecretString || payload.SecretBinary || secret.value
		value := norm(payload["SecretString"])
		if !jsnum.Truthy(value) {
			value = norm(payload["SecretBinary"])
		}
		if !jsnum.Truthy(value) {
			value = secret["value"]
		}
		secret["value"] = value
		secret["updated"] = float64(state.NowMs())
		newVerID = "v-" + strconv.Itoa(len(versions)+1)
		newVer := map[string]any{"id": newVerID, "stage": "AWSCURRENT", "created": float64(state.NowMs())}
		secret["versions"] = append([]any{newVer}, versions...)
	})
	if secret == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Secret not found: "+id)
		return
	}
	respond.JSON(w, 200, map[string]any{"ARN": secret["arn"], "Name": secret["name"], "VersionId": newVerID})
}

func (svc *Service) deleteSecret(w http.ResponseWriter, payload map[string]any) {
	id := keyOf(payload["SecretId"])
	var secret map[string]any
	svc.st.With(func(s *state.State) {
		secret = asMap(s.SecretsManager.Secrets[id])
		if secret != nil {
			delete(s.SecretsManager.Secrets, id)
		}
	})
	if secret == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Secret not found: "+id)
		return
	}
	deletionDate := state.ISO(state.NowMs() + 30*24*60*60*1000)
	respond.JSON(w, 200, map[string]any{"ARN": secret["arn"], "Name": secret["name"], "DeletionDate": deletionDate})
}

func (svc *Service) listSecrets(w http.ResponseWriter) {
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
			updated := jsnum.ToNumber(sec["updated"]) / 1000
			secrets = append(secrets, map[string]any{
				"ARN": sec["arn"], "Name": sec["name"],
				"LastChangedDate": updated, "LastAccessedDate": updated,
			})
		}
	})
	respond.JSON(w, 200, map[string]any{"SecretList": secrets})
}

func (svc *Service) describeSecret(w http.ResponseWriter, payload map[string]any) {
	id := keyOf(payload["SecretId"])
	var secret map[string]any
	versionStages := map[string]any{}
	svc.st.With(func(s *state.State) {
		secret = asMap(s.SecretsManager.Secrets[id])
		if secret == nil {
			return
		}
		for _, v := range secret["versions"].([]any) {
			ver := asMap(v)
			versionStages[jsnum.ToString(ver["id"])] = []any{ver["stage"]}
		}
	})
	if secret == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Secret not found: "+id)
		return
	}
	respond.JSON(w, 200, map[string]any{
		"ARN": secret["arn"], "Name": secret["name"],
		"CreatedDate":        jsnum.ToNumber(secret["created"]) / 1000,
		"LastChangedDate":    jsnum.ToNumber(secret["updated"]) / 1000,
		"VersionIdsToStages": versionStages,
	})
}
