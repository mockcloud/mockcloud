// Event delivery — port of src/services/eventbridge.js lines ~74-217:
// putEvents (ring buffer capped at 1000 + fire-and-forget rule matching),
// matchesPattern (DELIBERATELY SHALLOW: only source / detail-type via JS
// includes semantics — real EventBridge patterns are out of scope),
// deliverToTargets (ARN substring dispatch), and the rate()/cron() schedule
// sweep (fireDueSchedulesOnce).
package eventbridge

import (
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/services/sqs"
	"github.com/mockcloud/mockcloud/internal/state"
)

const account = "000000000000"

// detailTypeOf — Node's `entry['detail-type'] || entry.DetailType` (nil when
// both are absent/falsy; JSON.stringify then drops the key, see setDefined).
func detailTypeOf(entry map[string]any) any {
	v := entry["detail-type"]
	if jsnum.Falsy(v) {
		v = entry["DetailType"]
		if jsnum.Falsy(v) {
			return nil
		}
	}
	return v
}

// setDefined mirrors JSON.stringify dropping undefined-valued keys: Node set
// envelope/event-record fields to possibly-undefined values, and undefined
// keys vanish on every observable surface (delivery payloads, snapshots).
func setDefined(m map[string]any, key string, v any) {
	if v != nil {
		m[key] = v
	}
}

func (svc *Service) putEvents(w http.ResponseWriter, b map[string]any) {
	entries, _ := b["Entries"].([]any)
	results := []map[string]any{}
	var toFire []map[string]any

	svc.st.With(func(s *state.State) {
		for _, raw := range entries {
			entry, _ := raw.(map[string]any)
			if entry == nil {
				entry = map[string]any{}
			}
			eventID := state.RandomID(36)
			results = append(results, map[string]any{"EventId": eventID})
			bus := "default"
			if v, ok := entry["EventBusName"].(string); ok && v != "" {
				bus = v
			}
			rec := map[string]any{"id": eventID, "bus": bus, "time": state.NowMs()}
			setDefined(rec, "source", entry["Source"])
			setDefined(rec, "detailType", detailTypeOf(entry))
			setDefined(rec, "detail", entry["Detail"])
			s.EventBridge.Events = append([]map[string]any{rec}, s.EventBridge.Events...)
			if len(s.EventBridge.Events) > 1000 {
				s.EventBridge.Events = s.EventBridge.Events[:len(s.EventBridge.Events)-1]
			}
			toFire = append(toFire, entry)
		}
		s.AddTrail(map[string]any{"method": "POST", "path": "/events/PutEvents", "status": 200, "latency": 5})
	})

	// Fire matching rules — fire-and-forget, never under the store lock
	// (Node: fireMatchingRules(entry).catch(() => {})).
	for _, entry := range toFire {
		entry := entry
		go svc.fireMatchingRules(entry)
	}

	respond.JSON(w, 200, map[string]any{"FailedEntryCount": 0, "Entries": results})
}

func (svc *Service) fireMatchingRules(entry map[string]any) {
	busName := "default"
	if v, ok := entry["EventBusName"].(string); ok && v != "" {
		busName = v
	}

	// EventBridge wraps the user's Detail in this envelope when delivering to
	// targets. Most consumers (Lambda especially) parse this shape.
	envelope := map[string]any{
		"version": "0",
		"id":      state.RandomID(36),
		"account": account,
		"time":    state.ISO(state.NowMs()),
		"region":  "us-east-1",
		"detail":  safeParseDetail(entry["Detail"]),
	}
	setDefined(envelope, "detail-type", detailTypeOf(entry))
	setDefined(envelope, "source", entry["Source"])
	if res, ok := entry["Resources"].([]any); ok && res != nil {
		envelope["resources"] = res
	} else {
		envelope["resources"] = []any{}
	}

	var targetLists [][]map[string]any
	svc.st.With(func(s *state.State) {
		bus := s.EventBridge.Buses[busName]
		if bus == nil {
			return
		}
		names := make([]string, 0, len(bus.Rules))
		for n := range bus.Rules {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			rule := bus.Rules[n]
			if rule.State != "ENABLED" {
				continue
			}
			if !matchesPattern(rule.EventPattern, entry) {
				continue
			}
			targetLists = append(targetLists, append([]map[string]any{}, rule.Targets...))
		}
	})

	for _, targets := range targetLists {
		svc.deliverToTargets(targets, envelope)
	}
}

// deliverToTargets delivers an envelope to every target of a rule — shared by
// event-matched delivery (PutEvents) and schedule-driven delivery. MUST be
// called OUTSIDE the store lock (SQS enqueues re-enter it; the seams do too).
func (svc *Service) deliverToTargets(targets []map[string]any, envelope map[string]any) {
	envJSON := string(respond.Marshal(envelope))
	for _, target := range targets {
		arn, _ := target["Arn"].(string)
		switch {
		case arn == "":
			// Node: target.Arn?.includes — undefined matches no branch.
		case strings.Contains(arn, ":lambda:") || strings.Contains(arn, ":function:"):
			parts := strings.Split(arn, ":")
			if svc.InvokeLambda != nil {
				svc.InvokeLambda(parts[len(parts)-1], envJSON)
			}
		case strings.Contains(arn, ":sqs:"):
			qurl := sqs.QueueURLForArn(arn)
			svc.st.With(func(s *state.State) {
				if qurl != "" && s.SQS.Queues[qurl] != nil {
					sqs.EnqueueJSONLocked(s, qurl, envJSON)
				}
			})
		case strings.Contains(arn, ":sns:"):
			var exists bool
			svc.st.With(func(s *state.State) {
				if t := s.SNS.Topics[arn]; t != nil {
					t.Published++
					exists = true
				}
			})
			if exists && svc.FanoutSNS != nil {
				subject, _ := envelope["detail-type"].(string) // envelope['detail-type'] || ''
				svc.FanoutSNS(arn, state.RandomID(36), envJSON, subject)
			}
		case strings.Contains(arn, ":states:"):
			// EventBridge sends the matched event as the execution input.
			if svc.StartSFN != nil {
				svc.StartSFN(arn, envJSON)
			}
		}
	}
}

// safeParseDetail — Node's safeParseDetail: falsy → {}, objects pass through,
// strings JSON.parse'd (raw string kept when unparseable).
func safeParseDetail(d any) any {
	if d == nil || jsnum.Falsy(d) {
		return map[string]any{}
	}
	if s, ok := d.(string); ok {
		var v any
		// Plain Unmarshal (float64 numbers) — exactly what JSON.parse produced.
		if err := json.Unmarshal([]byte(s), &v); err == nil {
			return v
		}
		return s
	}
	return d
}

// matchesPattern is DELIBERATELY SHALLOW (a Node quirk that is conformance
// surface): only `source` and `detail-type` are consulted, via JS includes
// semantics. `detail`, prefixes, numeric matching etc. are ignored.
func matchesPattern(patternStr *string, entry map[string]any) bool {
	if patternStr == nil || *patternStr == "" {
		return false
	}
	var pattern any
	if err := json.Unmarshal([]byte(*patternStr), &pattern); err != nil {
		return false
	}
	pm, isMap := pattern.(map[string]any)
	if !isMap {
		// JSON null → Node threw on property access → false. Any other
		// non-object (string/number/array) has undefined .source /
		// ['detail-type'] → both checks skipped → match.
		return pattern != nil
	}
	if v, ok := pm["source"]; ok && jsnum.Truthy(v) {
		if !jsIncludes(v, entry["Source"]) {
			return false
		}
	}
	if v, ok := pm["detail-type"]; ok && jsnum.Truthy(v) {
		dt := entry["detail-type"]
		if jsnum.Falsy(dt) {
			dt = entry["DetailType"]
		}
		if !jsIncludes(v, dt) {
			return false
		}
	}
	return true
}

// jsIncludes — JS `haystack.includes(needle)` for the two shapes a pattern
// value takes: Array.includes (SameValueZero) or String.includes (substring).
// Anything else threw a TypeError in Node → caught → no match.
func jsIncludes(haystack, needle any) bool {
	if n, ok := needle.(json.Number); ok { // entry decoded with UseNumber
		if f, err := n.Float64(); err == nil {
			needle = f
		}
	}
	switch h := haystack.(type) {
	case []any:
		for _, item := range h {
			if jsnum.SameValueZero(item, needle) {
				return true
			}
		}
		return false
	case string:
		return strings.Contains(h, jsnum.ToString(needle))
	default:
		return false
	}
}

// ── Scheduled rules (rate/cron) ────────────────────────────────────────────
// rate(N unit) is exact; ANY cron(...) is approximated to a fixed 60s cadence
// (full cron-field parsing isn't implemented — Node quirk). Registered as a
// background tick; FireDueSchedulesOnce(now) is exported so the test hook can
// drive it deterministically.

var rateRe = regexp.MustCompile(`^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$`)

func parseSchedule(expr string) int64 {
	if m := rateRe.FindStringSubmatch(expr); m != nil {
		var unit int64
		switch {
		case strings.HasPrefix(m[2], "minute"):
			unit = 60_000
		case strings.HasPrefix(m[2], "hour"):
			unit = 3_600_000
		default:
			unit = 86_400_000
		}
		n := int64(jsnum.ParseIntPrefix(m[1]))
		return n * unit
	}
	if strings.HasPrefix(expr, "cron(") {
		return 60_000
	}
	return 0
}

// FireDueSchedulesOnce runs one schedule sweep at the given clock. The lazy
// _nextFireAt bookkeeping lives on the rule (Rule.NextFireAt/LastFiredAt) —
// first due time is created+interval, then now+interval after each firing.
// Deliveries happen after the lock is released; SQS enqueues complete before
// this returns (the fire-schedules test hook depends on that).
func (svc *Service) FireDueSchedulesOnce(now int64) {
	type job struct {
		targets  []map[string]any
		envelope map[string]any
	}
	var jobs []job
	svc.st.With(func(s *state.State) {
		busNames := make([]string, 0, len(s.EventBridge.Buses))
		for n := range s.EventBridge.Buses {
			busNames = append(busNames, n)
		}
		sort.Strings(busNames)
		for _, bn := range busNames {
			bus := s.EventBridge.Buses[bn]
			ruleNames := make([]string, 0, len(bus.Rules))
			for n := range bus.Rules {
				ruleNames = append(ruleNames, n)
			}
			sort.Strings(ruleNames)
			for _, rn := range ruleNames {
				rule := bus.Rules[rn]
				if rule.State != "ENABLED" || rule.ScheduleExpression == nil || *rule.ScheduleExpression == "" {
					continue
				}
				intervalMs := parseSchedule(*rule.ScheduleExpression)
				if intervalMs == 0 {
					continue
				}
				if rule.NextFireAt == nil {
					created := rule.Created
					if created == 0 { // Node: rule.created || now
						created = now
					}
					next := created + intervalMs
					rule.NextFireAt = &next
				}
				if now < *rule.NextFireAt {
					continue
				}
				next, last := now+intervalMs, now
				rule.NextFireAt = &next
				rule.LastFiredAt = &last
				jobs = append(jobs, job{
					targets: append([]map[string]any{}, rule.Targets...),
					envelope: map[string]any{
						"version": "0", "id": state.RandomID(36), "detail-type": "Scheduled Event",
						"source": "aws.events", "account": account, "time": state.ISO(now),
						"region": "us-east-1", "resources": []any{rule.Arn}, "detail": map[string]any{},
					},
				})
			}
		}
	})
	for _, j := range jobs {
		svc.deliverToTargets(j.targets, j.envelope)
	}
}
