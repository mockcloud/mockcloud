// Package lambda — port of src/services/lambda.js.
//
// M1 scope: function CRUD + the synthetic invoke path (non-Node runtimes /
// no code) with fn.logs. The real Node child-process sandbox, zip extraction,
// event-source mappings and CloudWatch Logs streaming land in M2/M6.
package lambda

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mockcloud/mockcloud/internal/config"
	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/services/logs"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

const codeSizeCap = 256 * 1024

var handlerRe = mustCompile(`^[A-Za-z0-9_.-]{1,128}$`)

func mustCompile(p string) *regexpLike { return &regexpLike{p} }

// regexpLike defers to a tiny hand check — the pattern is a simple character
// class + length bound; avoiding regexp keeps this hot path allocation-free.
type regexpLike struct{ p string }

func (r *regexpLike) MatchString(s string) bool {
	if len(s) < 1 || len(s) > 128 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '_', c == '.', c == '-':
		default:
			return false
		}
	}
	return true
}

type Service struct {
	st  *store.Store
	cfg *config.Config

	// Re-entrancy guard (internalBudgetExceeded): internally-triggered invokes
	// budgeted per rolling 5s window. Module-local in Node, not store state.
	mu          sync.Mutex
	windowStart int64
	windowCount int
}

func New(st *store.Store, cfg *config.Config) *Service {
	return &Service{st: st, cfg: cfg}
}

func (l *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	parts := strings.FieldsFunc(r.URL.EscapedPath(), func(c rune) bool { return c == '/' })
	// /2015-03-31/functions[/:name[/invocations|code]]
	var fnName, action string
	if len(parts) > 2 {
		fnName = parts[2]
	}
	if len(parts) > 3 {
		action = parts[3]
	}
	payload := r.JSONBody()

	if len(parts) > 1 && parts[1] == "event-source-mappings" {
		l.handleEventSourceMappings(w, r, parts, payload)
		return
	}

	switch {
	// ── List functions ──────────────────────────────────────────────────
	case r.Method == "GET" && fnName == "":
		var fns []map[string]any
		l.st.With(func(s *state.State) {
			for _, fn := range s.Lambda.Functions {
				fns = append(fns, fnConfig(fn))
			}
		})
		if fns == nil {
			fns = []map[string]any{}
		}
		respond.JSON(w, 200, map[string]any{"Functions": fns})

	// ── Create function ─────────────────────────────────────────────────
	case r.Method == "POST" && fnName == "":
		name := httpapi.Str(payload, "FunctionName")
		if name == "" {
			respond.ErrorJSON(w, 400, "ValidationException", "FunctionName required")
			return
		}
		handlerName := httpapi.Str(payload, "Handler")
		if handlerName == "" {
			handlerName = "index.handler"
		}
		if !handlerRe.MatchString(handlerName) {
			respond.ErrorJSON(w, 400, "ValidationException", "Handler must match [A-Za-z0-9_.-]{1,128}")
			return
		}
		var conflict bool
		var created map[string]any
		l.st.With(func(s *state.State) {
			if s.Lambda.Functions[name] != nil {
				conflict = true
				return
			}
			runtime := httpapi.Str(payload, "Runtime")
			if runtime == "" {
				runtime = "nodejs20.x"
			}
			memory, ok := httpapi.Num(payload, "MemorySize")
			if !ok {
				memory = 128
			}
			timeout, ok := httpapi.Num(payload, "Timeout")
			if !ok {
				timeout = 3
			}
			env := map[string]string{}
			if e, ok := payload["Environment"].(map[string]any); ok {
				if vars, ok := e["Variables"].(map[string]any); ok {
					for k, v := range vars {
						if sv, ok := v.(string); ok {
							env[k] = sv
						}
					}
				}
			}
			layers, _ := payload["Layers"].([]any)
			if layers == nil {
				layers = []any{}
			}
			fn := &state.LambdaFn{
				Name: name, Runtime: runtime, Handler: handlerName,
				Role: httpapi.Str(payload, "Role"), Memory: memory, Timeout: timeout,
				Env: env, Layers: layers, Code: decodeUploadedCode(payload["Code"]),
				Created: state.NowMs(), Logs: []state.LogLine{},
			}
			s.Lambda.Functions[name] = fn
			created = fnConfig(fn)
		})
		if conflict {
			respond.ErrorJSON(w, 409, "ResourceConflictException", "Function already exists: "+name)
			return
		}
		respond.JSON(w, 201, created)

	// ── Get function ────────────────────────────────────────────────────
	case r.Method == "GET" && fnName != "" && action == "":
		var cfg map[string]any
		l.st.With(func(s *state.State) {
			if fn := s.Lambda.Functions[fnName]; fn != nil {
				cfg = fnConfig(fn)
			}
		})
		if cfg == nil {
			respond.ErrorJSON(w, 404, "ResourceNotFoundException", "Function not found: "+fnName)
			return
		}
		respond.JSON(w, 200, map[string]any{
			"Configuration": cfg,
			"Code":          map[string]any{"Location": "http://localhost:4566/lambda-code/" + fnName + ".zip"},
			"Tags":          map[string]any{},
		})

	// ── Delete function ─────────────────────────────────────────────────
	case r.Method == "DELETE" && fnName != "" && action == "":
		var found bool
		l.st.With(func(s *state.State) {
			if s.Lambda.Functions[fnName] != nil {
				found = true
				delete(s.Lambda.Functions, fnName)
			}
		})
		if !found {
			respond.ErrorJSON(w, 404, "ResourceNotFoundException", "Function not found: "+fnName)
			return
		}
		w.WriteHeader(204)

	// ── Invoke ──────────────────────────────────────────────────────────
	case r.Method == "POST" && fnName != "" && action == "invocations":
		var exists bool
		l.st.With(func(s *state.State) { exists = s.Lambda.Functions[fnName] != nil })
		if !exists {
			respond.ErrorJSON(w, 404, "ResourceNotFoundException", "Function not found: "+fnName)
			return
		}
		invType := r.Header.Get("x-amz-invocation-type")
		if invType == "" {
			invType = "RequestResponse"
		}
		requestID := state.RandomID(36)
		event := string(r.RawBody)
		if event == "" {
			event = "{}"
		}

		if invType == "Event" {
			go l.Invoke(fnName, event, "aws-api", requestID)
			w.Header().Set("x-amzn-requestid", requestID)
			w.WriteHeader(202)
			return
		}

		outcome := l.Invoke(fnName, event, "aws-api", requestID)
		if outcome.Error != "" {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("x-amzn-requestid", requestID)
			w.Header().Set("x-amz-function-error", "Unhandled")
			w.WriteHeader(200)
			_, _ = w.Write(respond.Marshal(map[string]any{"errorMessage": outcome.Error, "errorType": "Error"}))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("x-amzn-requestid", requestID)
		w.Header().Set("x-amz-executed-version", "$LATEST")
		w.Header().Set("x-amzn-trace-id", "Root=1-"+state.RandomID(8)+"-"+state.RandomID(24))
		w.WriteHeader(200)
		_, _ = w.Write([]byte(outcome.Result))

	// ── Upload code (PUT /code) ──────────────────────────────────────────
	case r.Method == "PUT" && fnName != "" && action == "code":
		var cfg map[string]any
		l.st.With(func(s *state.State) {
			fn := s.Lambda.Functions[fnName]
			if fn == nil {
				return
			}
			code := decodeUploadedCode(anyMap(payload))
			if code == "" {
				raw := string(r.RawBody)
				if len(raw) > 10240 {
					raw = raw[:10240]
				}
				code = raw
			}
			fn.Code = code
			cfg = fnConfig(fn)
		})
		if cfg == nil {
			respond.ErrorJSON(w, 404, "ResourceNotFoundException", "Function not found: "+fnName)
			return
		}
		respond.JSON(w, 200, cfg)

	// ── Get / update function configuration ──────────────────────────────
	case fnName != "" && action == "configuration" && (r.Method == "GET" || r.Method == "PUT"):
		var cfg map[string]any
		l.st.With(func(s *state.State) {
			fn := s.Lambda.Functions[fnName]
			if fn == nil {
				return
			}
			if r.Method == "PUT" {
				if v, ok := httpapi.Num(payload, "MemorySize"); ok {
					fn.Memory = v
				}
				if v, ok := httpapi.Num(payload, "Timeout"); ok {
					fn.Timeout = v
				}
				if _, ok := payload["Handler"]; ok {
					fn.Handler = httpapi.Str(payload, "Handler")
				}
				if _, ok := payload["Runtime"]; ok {
					fn.Runtime = httpapi.Str(payload, "Runtime")
				}
				if _, ok := payload["Role"]; ok {
					fn.Role = httpapi.Str(payload, "Role")
				}
				if e, ok := payload["Environment"].(map[string]any); ok {
					if vars, ok := e["Variables"].(map[string]any); ok {
						env := map[string]string{}
						for k, v := range vars {
							if sv, ok := v.(string); ok {
								env[k] = sv
							}
						}
						fn.Env = env
					}
				}
				if layers, ok := payload["Layers"].([]any); ok {
					fn.Layers = layers
				}
			}
			cfg = fnConfig(fn)
		})
		if cfg == nil {
			respond.ErrorJSON(w, 404, "ResourceNotFoundException", "Function not found: "+fnName)
			return
		}
		respond.JSON(w, 200, cfg)

	// ── List versions ────────────────────────────────────────────────────
	case r.Method == "GET" && fnName != "" && action == "versions":
		var cfg map[string]any
		l.st.With(func(s *state.State) {
			if fn := s.Lambda.Functions[fnName]; fn != nil {
				cfg = fnConfig(fn)
			}
		})
		if cfg == nil {
			respond.ErrorJSON(w, 404, "ResourceNotFoundException", "Function not found: "+fnName)
			return
		}
		cfg["Version"] = "$LATEST"
		respond.JSON(w, 200, map[string]any{"Versions": []any{cfg}, "NextMarker": nil})

	// ── Code signing config (200 with empty ARN — provider crashes on 404) ─
	case fnName != "" && action == "code-signing-config":
		respond.JSON(w, 200, map[string]any{"CodeSigningConfigArn": "", "FunctionName": fnName})

	case r.Method == "GET" && fnName != "" && action == "concurrency":
		respond.JSON(w, 200, map[string]any{"ReservedConcurrentExecutions": -1})

	case r.Method == "GET" && fnName != "" && action == "policy":
		respond.ErrorJSON(w, 404, "ResourceNotFoundException", "No policy for function: "+fnName)

	// Broad catch: unknown GET sub-resource under a function → JSON 404.
	case r.Method == "GET" && fnName != "" && action != "":
		respond.ErrorJSON(w, 404, "ResourceNotFoundException", "Unsupported sub-resource: "+action)

	default:
		respond.ErrorJSON(w, 400, "UnknownOperation", "Unknown Lambda operation: "+r.Method+" "+r.URL.EscapedPath())
	}
}

// anyMap passes a parsed JSON body straight through (decodeUploadedCode's
// payload IS the Code document on PUT /code, unlike CreateFunction where it
// nests under payload.Code).
func anyMap(m map[string]any) any {
	if len(m) == 0 {
		return nil
	}
	return m
}

// RegisterUIRoutes adds the /mockcloud/lambda/* control-plane routes
// (src/routes/lambda.js) via a callback, mirroring the DynamoDB pattern.
func (l *Service) RegisterUIRoutes(add func(method, pattern string, h func(http.ResponseWriter, *httpapi.Request))) {
	add("GET", "/mockcloud/lambda/functions", func(w http.ResponseWriter, r *httpapi.Request) {
		fns := []map[string]any{}
		l.st.With(func(s *state.State) {
			for _, f := range s.Lambda.Functions {
				var lastInvoked any
				if f.LastInvoked != nil {
					lastInvoked = *f.LastInvoked
				}
				fns = append(fns, map[string]any{
					"name": f.Name, "runtime": f.Runtime, "handler": f.Handler,
					"memory": f.Memory, "timeout": f.Timeout,
					"invocations": f.Invocations, "errors": f.Errors,
					"created": f.Created, "lastInvoked": lastInvoked,
				})
			}
		})
		respond.JSON(w, 200, map[string]any{"functions": fns})
	})
}

// Outcome mirrors invokeLambda's return object.
type Outcome struct {
	Result    string
	Duration  int64
	Error     string
	RequestID string
}

// Invoke is the internal invocation path (invokeLambda). Splits lock → run →
// lock so the sandbox (M6) never executes under the store mutex.
func (l *Service) Invoke(fnName, eventStr, source, requestID string) Outcome {
	if requestID == "" {
		requestID = state.RandomID(36)
	}
	if l.budgetExceeded(source) {
		return Outcome{Error: "MockCloud re-entrancy guard: internal invocation budget exceeded (possible event loop)", RequestID: requestID}
	}

	start := state.NowMs()
	// Execution logs stream to CloudWatch Logs at /aws/lambda/<fn> so
	// `aws logs tail` / FilterLogEvents work like real Lambda.
	logGroup := "/aws/lambda/" + fnName
	logStream := time.Now().UTC().Format("2006/01/02") + "/[$LATEST]" + requestID
	var spec sandboxSpec
	var found bool
	l.st.With(func(s *state.State) {
		fn := s.Lambda.Functions[fnName]
		if fn == nil {
			return
		}
		found = true
		fn.Invocations++
		now := state.NowMs()
		fn.LastInvoked = &now
		spec = sandboxSpec{
			name: fn.Name, code: fn.Code, handler: fn.Handler, runtime: fn.Runtime,
			timeout: fn.Timeout, memory: fn.Memory, env: fn.Env,
		}
		l.logLine(s, fn, logGroup, logStream, "INFO", "START RequestId: "+requestID+" Source: "+sourceOr(source))
	})
	if !found {
		return Outcome{Error: "Function not found: " + fnName, RequestID: requestID}
	}

	var result, errStr string
	if strings.HasPrefix(spec.runtime, "nodejs") && spec.code != "" {
		// Real Node child-process sandbox — runs OUTSIDE the store lock.
		out, err := runInNodeSandbox(spec, eventStr)
		if err != nil {
			errStr = err.Error()
		} else {
			result = out
		}
	} else {
		// Synthetic response when no code uploaded or non-Node runtime.
		var event any
		if err := jsonUnmarshalAny(eventStr, &event); err != nil {
			event = eventStr
		}
		result = string(respond.Marshal(orderedSynthetic{
			StatusCode: 200,
			Body: string(respond.Marshal(orderedSyntheticBody{
				Message: "invoked (synthetic — no code uploaded)", Function: fnName,
				Runtime: spec.runtime, Event: event,
			})),
		}))
	}

	duration := state.NowMs() - start
	l.st.With(func(s *state.State) {
		fn := s.Lambda.Functions[fnName]
		if fn == nil {
			return
		}
		status := "200"
		if errStr != "" {
			fn.Errors++
			l.logLine(s, fn, logGroup, logStream, "ERROR", "Invocation failed: "+errStr)
			status = "500"
		}
		l.logLine(s, fn, logGroup, logStream, "INFO", "END Duration: "+itoa(duration)+"ms Status: "+status)
	})
	return Outcome{Result: result, Duration: duration, Error: errStr, RequestID: requestID}
}

type orderedSynthetic struct {
	StatusCode int    `json:"statusCode"`
	Body       string `json:"body"`
}
type orderedSyntheticBody struct {
	Message  string `json:"message"`
	Function string `json:"function"`
	Runtime  string `json:"runtime"`
	Event    any    `json:"event"`
}

// logLine ports invokeLambda's log(): prepend to fn.logs (cap 200) AND
// stream to CloudWatch Logs. Called inside store.With.
func (l *Service) logLine(s *state.State, fn *state.LambdaFn, group, stream, level, msg string) {
	fn.Logs = append([]state.LogLine{{T: state.NowMs(), Level: level, Msg: msg}}, fn.Logs...)
	if len(fn.Logs) > 200 {
		fn.Logs = fn.Logs[:200]
	}
	logs.PutLogEventLocked(s, l.cfg.MaxLogStreams, group, stream, "["+level+"] "+msg, state.NowMs())
}

func (l *Service) budgetExceeded(source string) bool {
	if source == "aws-api" {
		return false // direct API invokes are never capped
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := state.NowMs()
	if now-l.windowStart > 5000 {
		l.windowStart, l.windowCount = now, 0
	}
	l.windowCount++
	return l.windowCount > l.cfg.MaxInternalInvokes
}

func decodeUploadedCode(codeField any) string {
	switch v := codeField.(type) {
	case string:
		return cap256(v)
	case map[string]any:
		if zf, ok := v["ZipFile"].(string); ok {
			buf, err := base64.StdEncoding.DecodeString(zf)
			if err != nil {
				return ""
			}
			// Real zip first; on any parse failure treat the bytes as raw source
			// (the path most tests use — they send plain JS in ZipFile).
			if code, ok := extractZip(buf); ok {
				return code
			}
			return cap256(string(buf))
		}
	}
	return ""
}

func cap256(s string) string {
	if len(s) > codeSizeCap {
		return s[:codeSizeCap]
	}
	return s
}

// fnConfig — ordered response shape (src/services/lambda.js fnConfig).
func fnConfig(fn *state.LambdaFn) map[string]any {
	layers := []map[string]any{}
	for _, a := range fn.Layers {
		layers = append(layers, map[string]any{"Arn": a, "CodeSize": 0})
	}
	var lastInvoked any
	if fn.LastInvoked != nil {
		lastInvoked = *fn.LastInvoked
	}
	return map[string]any{
		"FunctionName": fn.Name,
		"FunctionArn":  state.Arn("lambda", "function:"+fn.Name),
		"Runtime":      fn.Runtime,
		"Handler":      fn.Handler,
		"Role":         roleOr(fn),
		"MemorySize":   fn.Memory,
		"Timeout":      fn.Timeout,
		"PackageType":  "Zip",
		"Architectures": []string{"x86_64"},
		"Environment":  map[string]any{"Variables": fn.Env},
		"Layers":       layers,
		"TracingConfig": map[string]any{"Mode": "PassThrough"},
		"EphemeralStorage": map[string]any{"Size": 512},
		"LoggingConfig": map[string]any{"LogFormat": "Text", "LogGroup": "/aws/lambda/" + fn.Name},
		"State":           "Active",
		"StateReasonCode": "Idle",
		"LastModified":    state.ISO(fn.Created),
		"CodeSize":        len(fn.Code),
		"Version":         "$LATEST",
		"_invocations":    fn.Invocations,
		"_errors":         fn.Errors,
		"_lastInvoked":    lastInvoked,
		"_logs":           fn.Logs,
		"_created":        fn.Created,
	}
}

func roleOr(fn *state.LambdaFn) string {
	if fn.Role != "" {
		return fn.Role
	}
	return state.IamArn("role/" + fn.Name + "-role")
}

func sourceOr(source string) string {
	if source == "" {
		return "unknown"
	}
	return source
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func respondMD5(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

func jsonUnmarshalAny(s string, v *any) error {
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	return dec.Decode(v)
}
