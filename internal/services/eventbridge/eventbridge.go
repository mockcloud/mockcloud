// Package eventbridge — port of src/services/eventbridge.js.
//
// Rule/bus CRUD over the JSON protocol (M1) plus event delivery: PutEvents
// with the deliberately-shallow pattern matcher, target fan-out and
// rate()/cron() schedule firing (M7, delivery.go).
package eventbridge

import (
	"net/http"
	"sort"
	"strings"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

// Service carries the store plus the cross-service delivery seams
// (deliverToTargets in Node lazy-imported lambda/sqs/sns/stepfunctions; here
// dispatch.New wires closures instead). Every seam is called OUTSIDE the
// store lock — Fanout and Invoke re-acquire it.
type Service struct {
	st *store.Store
	// InvokeLambda fires an EventBridge envelope at a function
	// (fire-and-forget, source 'eventbridge').
	InvokeLambda func(fnName, eventJSON string)
	// FanoutSNS delivers a published message to a topic's subscribers
	// (fire-and-forget).
	FanoutSNS func(topicArn, msgID, message, subject string)
	// StartSFN starts a state-machine execution with the envelope as input.
	StartSFN func(stateMachineArn, inputJSON string)
}

func New(st *store.Store) *Service { return &Service{st: st} }

func (svc *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	st := svc.st
	target := r.Header.Get("x-amz-target")
	// SDK v2 uses 'AWSEvents.X', v3 uses 'AmazonEventBridge.X'.
	normalized := strings.Replace(target, "AWSEvents.", "AmazonEventBridge.", 1)
	op := strings.TrimPrefix(normalized, "AmazonEventBridge.")
	if op == normalized {
		respond.ErrorJSON(w, 400, "InvalidAction", "Unknown EventBridge action: "+target)
		return
	}
	b := r.JSONBody()
	busName := func() string {
		if n := httpapi.Str(b, "EventBusName"); n != "" {
			return n
		}
		return "default"
	}

	switch op {
	case "PutRule":
		name := httpapi.Str(b, "Name")
		if name == "" {
			respond.ErrorJSON(w, 400, "ValidationException", "Name required")
			return
		}
		bus := busName()
		ruleArn := state.Arn("events", "rule/"+bus+"/"+name)
		st.With(func(s *state.State) {
			if s.EventBridge.Buses[bus] == nil {
				s.EventBridge.Buses[bus] = &state.Bus{Name: bus, Rules: map[string]*state.Rule{}}
			}
			var schedExpr, patternStr *string
			if v := httpapi.Str(b, "ScheduleExpression"); v != "" {
				schedExpr = &v
			}
			if raw, ok := b["EventPattern"]; ok && raw != nil {
				var p string
				if sv, isStr := raw.(string); isStr {
					p = sv
				} else {
					p = string(respond.Marshal(raw))
				}
				patternStr = &p
			}
			ruleState := httpapi.Str(b, "State")
			if ruleState == "" {
				ruleState = "ENABLED"
			}
			var targets []map[string]any
			if prev := s.EventBridge.Buses[bus].Rules[name]; prev != nil {
				targets = prev.Targets
			}
			if targets == nil {
				targets = []map[string]any{}
			}
			s.EventBridge.Buses[bus].Rules[name] = &state.Rule{
				Name: name, Arn: ruleArn, EventBusName: bus,
				ScheduleExpression: schedExpr, EventPattern: patternStr,
				State: ruleState, Description: httpapi.Str(b, "Description"),
				Targets: targets, Created: state.NowMs(),
			}
			s.AddTrail(map[string]any{"method": "POST", "path": "/events/rule/" + name, "status": 200, "latency": 3})
		})
		respond.JSON(w, 200, map[string]any{"RuleArn": ruleArn})

	case "ListRules":
		type ruleOut struct {
			Name               string  `json:"Name"`
			Arn                string  `json:"Arn"`
			State              string  `json:"State"`
			ScheduleExpression *string `json:"ScheduleExpression"`
			EventPattern       *string `json:"EventPattern"`
			EventBusName       string  `json:"EventBusName"`
			Description        string  `json:"Description"`
		}
		var rules []ruleOut
		st.With(func(s *state.State) {
			bus := s.EventBridge.Buses[busName()]
			if bus == nil {
				return
			}
			for _, r := range bus.Rules {
				rules = append(rules, ruleOut{
					Name: r.Name, Arn: r.Arn, State: r.State,
					ScheduleExpression: r.ScheduleExpression, EventPattern: r.EventPattern,
					EventBusName: r.EventBusName, Description: r.Description,
				})
			}
		})
		sort.Slice(rules, func(i, j int) bool { return rules[i].Name < rules[j].Name })
		if rules == nil {
			rules = []ruleOut{}
		}
		respond.JSON(w, 200, map[string]any{"Rules": rules})

	case "DescribeRule":
		var rule *state.Rule
		st.With(func(s *state.State) {
			if bus := s.EventBridge.Buses[busName()]; bus != nil {
				rule = bus.Rules[httpapi.Str(b, "Name")]
			}
		})
		if rule == nil {
			respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Rule "+httpapi.Str(b, "Name")+" not found")
			return
		}
		respond.JSON(w, 200, rule)

	case "DeleteRule":
		name := httpapi.Str(b, "Name")
		st.With(func(s *state.State) {
			if bus := s.EventBridge.Buses[busName()]; bus != nil {
				delete(bus.Rules, name)
			}
			s.AddTrail(map[string]any{"method": "DELETE", "path": "/events/rule/" + name, "status": 200, "latency": 2})
		})
		respond.JSON(w, 200, map[string]any{})

	case "EnableRule", "DisableRule":
		newState := "ENABLED"
		if op == "DisableRule" {
			newState = "DISABLED"
		}
		st.With(func(s *state.State) {
			if bus := s.EventBridge.Buses[busName()]; bus != nil {
				if rule := bus.Rules[httpapi.Str(b, "Name")]; rule != nil {
					rule.State = newState
				}
			}
		})
		respond.JSON(w, 200, map[string]any{})

	case "PutTargets":
		var found bool
		st.With(func(s *state.State) {
			bus := s.EventBridge.Buses[busName()]
			if bus == nil {
				return
			}
			rule := bus.Rules[httpapi.Str(b, "Rule")]
			if rule == nil {
				return
			}
			found = true
			targets, _ := b["Targets"].([]any)
			for _, t := range targets {
				tm, ok := t.(map[string]any)
				if !ok {
					continue
				}
				replaced := false
				for i, existing := range rule.Targets {
					if existing["Id"] == tm["Id"] {
						rule.Targets[i] = tm
						replaced = true
						break
					}
				}
				if !replaced {
					rule.Targets = append(rule.Targets, tm)
				}
			}
		})
		if !found {
			respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Rule "+httpapi.Str(b, "Rule")+" not found")
			return
		}
		respond.JSON(w, 200, map[string]any{"FailedEntryCount": 0, "FailedEntries": []any{}})

	case "RemoveTargets":
		ids := map[any]struct{}{}
		if raw, ok := b["Ids"].([]any); ok {
			for _, id := range raw {
				ids[id] = struct{}{}
			}
		}
		st.With(func(s *state.State) {
			if bus := s.EventBridge.Buses[busName()]; bus != nil {
				if rule := bus.Rules[httpapi.Str(b, "Rule")]; rule != nil {
					kept := rule.Targets[:0]
					for _, t := range rule.Targets {
						if _, drop := ids[t["Id"]]; !drop {
							kept = append(kept, t)
						}
					}
					rule.Targets = kept
				}
			}
		})
		respond.JSON(w, 200, map[string]any{"FailedEntryCount": 0, "FailedEntries": []any{}})

	case "ListTargetsByRule":
		targets := []map[string]any{}
		st.With(func(s *state.State) {
			if bus := s.EventBridge.Buses[busName()]; bus != nil {
				if rule := bus.Rules[httpapi.Str(b, "Rule")]; rule != nil && rule.Targets != nil {
					targets = rule.Targets
				}
			}
		})
		respond.JSON(w, 200, map[string]any{"Targets": targets})

	case "ListEventBuses":
		type busOut struct {
			Name string `json:"Name"`
			Arn  string `json:"Arn"`
		}
		var buses []busOut
		hasDefault := false
		st.With(func(s *state.State) {
			for _, bus := range s.EventBridge.Buses {
				if bus.Name == "default" {
					hasDefault = true
				}
				buses = append(buses, busOut{Name: bus.Name, Arn: state.Arn("events", "event-bus/"+bus.Name)})
			}
		})
		sort.Slice(buses, func(i, j int) bool { return buses[i].Name < buses[j].Name })
		if !hasDefault {
			buses = append([]busOut{{Name: "default", Arn: state.Arn("events", "event-bus/default")}}, buses...)
		}
		respond.JSON(w, 200, map[string]any{"EventBuses": buses})

	case "DescribeEventBus":
		name := httpapi.Str(b, "Name")
		if name == "" {
			name = "default"
		}
		respond.JSON(w, 200, map[string]any{"Name": name, "Arn": state.Arn("events", "event-bus/"+name)})

	case "CreateEventBus":
		name := httpapi.Str(b, "Name")
		if name == "" {
			respond.ErrorJSON(w, 400, "ValidationException", "Name required")
			return
		}
		st.With(func(s *state.State) {
			s.EventBridge.Buses[name] = &state.Bus{Name: name, Rules: map[string]*state.Rule{}}
		})
		respond.JSON(w, 200, map[string]any{"EventBusArn": state.Arn("events", "event-bus/"+name)})

	case "DeleteEventBus", "TagResource":
		respond.JSON(w, 200, map[string]any{})

	case "ListTagsForResource":
		respond.JSON(w, 200, map[string]any{"Tags": []any{}})

	case "PutEvents":
		svc.putEvents(w, b)

	default:
		respond.ErrorJSON(w, 400, "InvalidAction", "Unknown EventBridge action: "+target)
	}
}
