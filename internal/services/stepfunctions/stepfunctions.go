// Package stepfunctions — port of src/services/stepfunctions.js (JSON
// protocol, X-Amz-Target: AWSStepFunctions.*).
//
// The definition is kept as an UNPARSED value — there is no ASL interpreter
// (parity says keep the stub): StartExecution simulates completion after
// ~500–1500ms, echoing the input as the output. State lives in the any-tree
// state.SFNState (stateMachines + a global executions map that
// DeleteStateMachine purges in lockstep).
package stepfunctions

import (
	"encoding/json"
	"math/rand"
	"net/http"
	"sort"
	"strings"
	"time"

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

// nameFromArn — Node's `arn?.split(':').pop()` (last segment; "" stays "").
func nameFromArn(arn string) string {
	parts := strings.Split(arn, ":")
	return parts[len(parts)-1]
}

// numF reads a numeric any-tree field (int64 when we stored it, float64 or
// json.Number after a snapshot import).
func numF(v any) float64 {
	switch t := v.(type) {
	case int64:
		return float64(t)
	case float64:
		return t
	case json.Number:
		f, _ := t.Float64()
		return f
	}
	return 0
}

func (svc *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	target := r.Header.Get("x-amz-target")
	op := strings.TrimPrefix(target, "AWSStepFunctions.")
	if op == target {
		respond.ErrorJSON(w, 400, "InvalidAction", "Unknown Step Functions action: "+target)
		return
	}
	b := r.JSONBody()

	switch op {
	case "CreateStateMachine":
		svc.createStateMachine(w, b)
	case "DeleteStateMachine":
		svc.deleteStateMachine(w, b)
	case "DescribeStateMachine":
		svc.describeStateMachine(w, b)
	case "ListStateMachines":
		svc.listStateMachines(w)
	case "UpdateStateMachine":
		svc.updateStateMachine(w, b)
	case "StartExecution":
		svc.startExecution(w, b)
	case "StopExecution":
		svc.stopExecution(w, b)
	case "DescribeExecution":
		svc.describeExecution(w, b)
	case "ListExecutions":
		svc.listExecutions(w, b)
	case "GetExecutionHistory":
		svc.getExecutionHistory(w, b)
	case "TagResource":
		respond.JSON(w, 200, map[string]any{})
	case "ListTagsForResource":
		respond.JSON(w, 200, map[string]any{"tags": []any{}})
	default:
		respond.ErrorJSON(w, 400, "InvalidAction", "Unknown Step Functions action: "+target)
	}
}

// orDefault — JS `v || def` over any-tree values.
func orDefault(v, def any) any {
	if jsnum.Truthy(v) {
		return v
	}
	return def
}

func (svc *Service) createStateMachine(w http.ResponseWriter, b map[string]any) {
	name := httpapi.Str(b, "name")
	if name == "" {
		respond.ErrorJSON(w, 400, "ValidationException", "name required")
		return
	}
	smArn := state.Arn("states", "stateMachine:"+name)
	var exists bool
	svc.st.With(func(s *state.State) {
		if _, ok := s.StepFunctions.StateMachines[name]; ok {
			exists = true
			return
		}
		s.StepFunctions.StateMachines[name] = map[string]any{
			"name":       name,
			"arn":        smArn,
			"definition": orDefault(b["definition"], "{}"),
			"roleArn":    orDefault(b["roleArn"], state.IamArn("role/StatesRole")),
			"type":       orDefault(b["type"], "STANDARD"),
			"status":     "ACTIVE",
			"created":    state.NowMs(),
			"executions": []any{},
		}
		s.AddTrail(map[string]any{"method": "POST", "path": "/states/" + name, "status": 200, "latency": 5})
	})
	if exists {
		respond.ErrorJSON(w, 400, "StateMachineAlreadyExists", "State machine "+name+" already exists")
		return
	}
	respond.JSON(w, 200, map[string]any{"stateMachineArn": smArn, "creationDate": float64(state.NowMs()) / 1000})
}

func (svc *Service) deleteStateMachine(w http.ResponseWriter, b map[string]any) {
	name := nameFromArn(httpapi.Str(b, "stateMachineArn"))
	svc.st.With(func(s *state.State) {
		// Purge the machine's executions from the global map too, or they'd
		// be orphaned there forever (Node audit fix).
		if sm, ok := s.StepFunctions.StateMachines[name].(map[string]any); ok {
			if execs, ok := sm["executions"].([]any); ok {
				for _, e := range execs {
					if em, ok := e.(map[string]any); ok {
						if arn, ok := em["executionArn"].(string); ok {
							delete(s.StepFunctions.Executions, arn)
						}
					}
				}
			}
		}
		delete(s.StepFunctions.StateMachines, name)
	})
	respond.JSON(w, 200, map[string]any{})
}

func (svc *Service) describeStateMachine(w http.ResponseWriter, b map[string]any) {
	name := nameFromArn(httpapi.Str(b, "stateMachineArn"))
	var raw []byte
	svc.st.With(func(s *state.State) {
		sm, _ := s.StepFunctions.StateMachines[name].(map[string]any)
		if sm == nil {
			return
		}
		out := make(map[string]any, len(sm)+1)
		for k, v := range sm {
			out[k] = v
		}
		out["creationDate"] = numF(sm["created"]) / 1000
		raw = respond.Marshal(out) // marshal under the lock — timers mutate executions
	})
	if raw == nil {
		respond.ErrorJSON(w, 400, "StateMachineDoesNotExist", "State machine not found")
		return
	}
	respond.JSON(w, 200, json.RawMessage(raw))
}

func (svc *Service) listStateMachines(w http.ResponseWriter) {
	out := []map[string]any{}
	svc.st.With(func(s *state.State) {
		names := make([]string, 0, len(s.StepFunctions.StateMachines))
		for n := range s.StepFunctions.StateMachines {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			sm, _ := s.StepFunctions.StateMachines[n].(map[string]any)
			if sm == nil {
				continue
			}
			out = append(out, map[string]any{
				"name": sm["name"], "stateMachineArn": sm["arn"], "type": sm["type"],
				"creationDate": numF(sm["created"]) / 1000, "status": sm["status"],
			})
		}
	})
	respond.JSON(w, 200, map[string]any{"stateMachines": out})
}

func (svc *Service) updateStateMachine(w http.ResponseWriter, b map[string]any) {
	name := nameFromArn(httpapi.Str(b, "stateMachineArn"))
	var found bool
	svc.st.With(func(s *state.State) {
		sm, _ := s.StepFunctions.StateMachines[name].(map[string]any)
		if sm == nil {
			return
		}
		found = true
		if jsnum.Truthy(b["definition"]) {
			sm["definition"] = b["definition"]
		}
		if jsnum.Truthy(b["roleArn"]) {
			sm["roleArn"] = b["roleArn"]
		}
	})
	if !found {
		respond.ErrorJSON(w, 400, "StateMachineDoesNotExist", "State machine not found")
		return
	}
	respond.JSON(w, 200, map[string]any{"updateDate": float64(state.NowMs()) / 1000})
}

func (svc *Service) startExecution(w http.ResponseWriter, b map[string]any) {
	// Node: b.input || '{}' — and startStateMachineExecution stringifies
	// non-string inputs.
	input := "{}"
	if raw := b["input"]; jsnum.Truthy(raw) {
		if s, ok := raw.(string); ok {
			input = s
		} else {
			input = string(respond.Marshal(raw))
		}
	}
	exec := svc.StartStateMachineExecution(httpapi.Str(b, "stateMachineArn"), input, httpapi.Str(b, "name"))
	if exec == nil {
		respond.ErrorJSON(w, 400, "StateMachineDoesNotExist", "State machine not found")
		return
	}
	respond.JSON(w, 200, map[string]any{"executionArn": exec.ExecutionArn, "startDate": exec.StartDate})
}

// StartedExecution is the caller-visible slice of a new execution.
type StartedExecution struct {
	ExecutionArn string
	StartDate    float64
}

// StartStateMachineExecution — programmatic StartExecution, shared by the
// HTTP API and by EventBridge targets whose ARN is a state machine. Returns
// nil when the state machine doesn't exist. Must be called OUTSIDE the store
// lock (it takes it).
func (svc *Service) StartStateMachineExecution(stateMachineArn, input, execName string) *StartedExecution {
	name := nameFromArn(stateMachineArn)
	finalName := execName
	if finalName == "" {
		finalName = "exec-" + state.RandomID(8)
	}
	execArn := state.Arn("states", "execution:"+name+":"+finalName)

	var started *StartedExecution
	var exec map[string]any
	svc.st.With(func(s *state.State) {
		sm, _ := s.StepFunctions.StateMachines[name].(map[string]any)
		if sm == nil {
			return
		}
		now := float64(state.NowMs()) / 1000
		exec = map[string]any{
			"name":            finalName,
			"executionArn":    execArn,
			"stateMachineArn": sm["arn"],
			"input":           input,
			"status":          "RUNNING",
			"startDate":       now,
			"stopDate":        nil,
			"output":          nil,
			"history": []any{map[string]any{
				"timestamp": now, "type": "ExecutionStarted",
				"executionStartedEventDetails": map[string]any{"input": input},
			}},
		}
		execs, _ := sm["executions"].([]any)
		execs = append([]any{exec}, execs...)
		// Cap per-machine history, evicting from the global map in lockstep so
		// a recurring trigger can't grow either unboundedly. Loop, not if:
		// over-cap states from a snapshot import drain too.
		for len(execs) > 1000 {
			if em, ok := execs[len(execs)-1].(map[string]any); ok {
				if arn, ok := em["executionArn"].(string); ok {
					delete(s.StepFunctions.Executions, arn)
				}
			}
			execs = execs[:len(execs)-1]
		}
		sm["executions"] = execs
		s.StepFunctions.Executions[execArn] = exec
		s.AddTrail(map[string]any{"method": "POST", "path": "/states/" + name + "/start", "status": 200, "latency": 10})
		started = &StartedExecution{ExecutionArn: execArn, StartDate: now}
	})
	if started == nil {
		return nil
	}

	// Simulate execution completing after ~500–1500ms (Node's unref'd
	// setTimeout). Unconditional SUCCEEDED — even over an ABORTED status —
	// is Node behavior; after a store reset the map is unreachable, so the
	// late mutation is harmless there too.
	delay := time.Duration(500+rand.Float64()*1000) * time.Millisecond
	time.AfterFunc(delay, func() {
		svc.st.With(func(s *state.State) {
			now := float64(state.NowMs()) / 1000
			exec["status"] = "SUCCEEDED"
			exec["stopDate"] = now
			exec["output"] = input
			hist, _ := exec["history"].([]any)
			exec["history"] = append(hist, map[string]any{
				"timestamp": now, "type": "ExecutionSucceeded",
				"executionSucceededEventDetails": map[string]any{"output": input},
			})
		})
	})
	return started
}

func (svc *Service) stopExecution(w http.ResponseWriter, b map[string]any) {
	arn := httpapi.Str(b, "executionArn")
	svc.st.With(func(s *state.State) {
		if exec, ok := s.StepFunctions.Executions[arn].(map[string]any); ok {
			exec["status"] = "ABORTED"
			exec["stopDate"] = float64(state.NowMs()) / 1000
		}
	})
	respond.JSON(w, 200, map[string]any{"stopDate": float64(state.NowMs()) / 1000})
}

func (svc *Service) describeExecution(w http.ResponseWriter, b map[string]any) {
	arn := httpapi.Str(b, "executionArn")
	var raw []byte
	svc.st.With(func(s *state.State) {
		if exec, ok := s.StepFunctions.Executions[arn].(map[string]any); ok {
			raw = respond.Marshal(exec) // under the lock — the timer mutates it
		}
	})
	if raw == nil {
		respond.ErrorJSON(w, 400, "ExecutionDoesNotExist", "Execution not found")
		return
	}
	respond.JSON(w, 200, json.RawMessage(raw))
}

func (svc *Service) listExecutions(w http.ResponseWriter, b map[string]any) {
	name := nameFromArn(httpapi.Str(b, "stateMachineArn"))
	statusFilter := httpapi.Str(b, "statusFilter")
	var found bool
	out := []map[string]any{}
	svc.st.With(func(s *state.State) {
		sm, _ := s.StepFunctions.StateMachines[name].(map[string]any)
		if sm == nil {
			return
		}
		found = true
		execs, _ := sm["executions"].([]any)
		for _, e := range execs {
			em, ok := e.(map[string]any)
			if !ok {
				continue
			}
			if statusFilter != "" && em["status"] != statusFilter {
				continue
			}
			out = append(out, map[string]any{
				"name": em["name"], "executionArn": em["executionArn"],
				"stateMachineArn": em["stateMachineArn"], "status": em["status"],
				"startDate": em["startDate"], "stopDate": em["stopDate"],
			})
		}
	})
	if !found {
		respond.ErrorJSON(w, 400, "StateMachineDoesNotExist", "State machine not found")
		return
	}
	respond.JSON(w, 200, map[string]any{"executions": out})
}

func (svc *Service) getExecutionHistory(w http.ResponseWriter, b map[string]any) {
	arn := httpapi.Str(b, "executionArn")
	var raw []byte
	svc.st.With(func(s *state.State) {
		exec, ok := s.StepFunctions.Executions[arn].(map[string]any)
		if !ok {
			return
		}
		hist, _ := exec["history"].([]any)
		events := make([]map[string]any, 0, len(hist))
		for i, e := range hist {
			out := map[string]any{"id": i + 1}
			if em, ok := e.(map[string]any); ok {
				for k, v := range em {
					out[k] = v
				}
			}
			events = append(events, out)
		}
		raw = respond.Marshal(map[string]any{"events": events})
	})
	if raw == nil {
		respond.ErrorJSON(w, 400, "ExecutionDoesNotExist", "Execution not found")
		return
	}
	respond.JSON(w, 200, json.RawMessage(raw))
}
