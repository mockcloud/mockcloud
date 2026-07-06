package lambda

import (
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/services/sqs"
	"github.com/mockcloud/mockcloud/internal/state"
)

// ── Event-source-mapping HTTP surface (handleEventSourceMappings) ───────────

func (l *Service) handleEventSourceMappings(w http.ResponseWriter, r *httpapi.Request, parts []string, payload map[string]any) {
	switch {
	// POST /2015-03-31/event-source-mappings
	case r.Method == "POST" && len(parts) == 2:
		fnParts := strings.Split(httpapi.Str(payload, "FunctionName"), ":")
		fnName := fnParts[len(fnParts)-1]
		sourceArn := httpapi.Str(payload, "EventSourceArn")
		if fnName == "" || sourceArn == "" {
			respond.ErrorJSON(w, 400, "InvalidParameterValueException", "FunctionName and EventSourceArn required")
			return
		}
		uuid := state.RandomID(36)
		batchSize, ok := httpapi.Num(payload, "BatchSize")
		if !ok || batchSize == 0 {
			batchSize = 10
		}
		mapping := map[string]any{
			"UUID":                  uuid,
			"FunctionArn":           state.Arn("lambda", "function:"+fnName),
			"EventSourceArn":        sourceArn,
			"BatchSize":             batchSize,
			"State":                 "Enabled",
			"StateTransitionReason": "User action",
			"LastModified":          float64(state.NowMs()) / 1000,
		}
		l.st.With(func(s *state.State) {
			if s.Lambda.EventSourceMappings == nil {
				s.Lambda.EventSourceMappings = map[string]map[string]any{}
			}
			s.Lambda.EventSourceMappings[uuid] = mapping
			// Wire DDB Streams trigger:
			// arn:aws:dynamodb:us-east-1:000000000000:table/<name>/stream/<created>
			if strings.Contains(sourceArn, ":dynamodb:") && strings.Contains(sourceArn, "/stream/") {
				if tableName := tableFromStreamArn(sourceArn); tableName != "" {
					existing, _ := s.DynamoDBStreams.Triggers[tableName].([]any)
					found := false
					for _, v := range existing {
						if v == fnName {
							found = true
							break
						}
					}
					if !found {
						s.DynamoDBStreams.Triggers[tableName] = append(existing, fnName)
					}
				}
			}
		})
		respond.JSON(w, 202, mapping)

	// GET /2015-03-31/event-source-mappings
	case r.Method == "GET" && len(parts) == 2:
		all := []map[string]any{}
		l.st.With(func(s *state.State) {
			for _, m := range s.Lambda.EventSourceMappings {
				all = append(all, m)
			}
		})
		respond.JSON(w, 200, map[string]any{"EventSourceMappings": all})

	// DELETE /2015-03-31/event-source-mappings/:uuid
	case r.Method == "DELETE" && len(parts) == 3:
		uuid := parts[2]
		var mapping map[string]any
		l.st.With(func(s *state.State) {
			mapping = s.Lambda.EventSourceMappings[uuid]
			if mapping == nil {
				return
			}
			if arn, _ := mapping["EventSourceArn"].(string); strings.Contains(arn, ":dynamodb:") {
				tableName := tableFromStreamArn(arn)
				fnArn, _ := mapping["FunctionArn"].(string)
				fnParts := strings.Split(fnArn, ":")
				fnName := fnParts[len(fnParts)-1]
				if existing, ok := s.DynamoDBStreams.Triggers[tableName].([]any); ok {
					var kept []any
					for _, v := range existing {
						if v != fnName {
							kept = append(kept, v)
						}
					}
					s.DynamoDBStreams.Triggers[tableName] = kept
				}
			}
			delete(s.Lambda.EventSourceMappings, uuid)
		})
		if mapping == nil {
			respond.ErrorJSON(w, 404, "ResourceNotFoundException", "Mapping not found")
			return
		}
		respond.JSON(w, 202, mapping)

	default:
		respond.ErrorJSON(w, 400, "UnknownOperation", "Unknown event-source-mapping operation")
	}
}

func md5hexLocal(s string) string {
	return respondMD5(s)
}

func tableFromStreamArn(arn string) string {
	_, after, ok := strings.Cut(arn, "table/")
	if !ok {
		return ""
	}
	return strings.Split(after, "/")[0]
}

// ── SQS → Lambda poller (lambda-esm.js) ─────────────────────────────────────
// One pass per lifecycle tick, never overlapping (a slow invoke just skips
// ticks, matching Node's `polling` flag). Batch selection/hide happens under
// the store lock; the invoke itself does not.

var pollingFlag atomic.Bool

func (l *Service) PollEventSourceMappingsOnce() {
	if !pollingFlag.CompareAndSwap(false, true) {
		return
	}
	defer pollingFlag.Store(false)

	type job struct {
		fnName    string
		sourceArn string
		event     string
		handles   map[string]struct{}
		queueURL  string
	}
	var jobs []job
	l.st.With(func(s *state.State) {
		for _, mapping := range s.Lambda.EventSourceMappings {
			if mapping["State"] != "Enabled" {
				continue
			}
			sourceArn, _ := mapping["EventSourceArn"].(string)
			if !strings.Contains(sourceArn, ":sqs:") {
				continue // DDB streams fire on write
			}
			queueURL := sqs.QueueURLForArn(sourceArn)
			q := s.SQS.Queues[queueURL]
			if q == nil {
				continue
			}
			batchSize := 10
			if bs, ok := mapping["BatchSize"].(float64); ok && bs > 0 {
				batchSize = int(bs)
			}
			batch := sqs.SelectMessagesLocked(s, q, batchSize)
			if len(batch) == 0 {
				continue
			}
			for _, m := range batch {
				sqs.HideMessageLocked(m, 30_000)
			}
			records := make([]map[string]any, 0, len(batch))
			handles := map[string]struct{}{}
			for _, m := range batch {
				handles[m.ReceiptHandle] = struct{}{}
				count := m.ApproxReceiveCount
				if count == 0 {
					count = 1
				}
				attrs := map[string]any{
					"ApproximateReceiveCount": itoa(int64(count)),
					"SentTimestamp":           itoa(m.Sent),
				}
				if m.GroupID != "" {
					attrs["MessageGroupId"] = m.GroupID
					attrs["SequenceNumber"] = m.SequenceNumber
				}
				records = append(records, map[string]any{
					"messageId":         m.ID,
					"receiptHandle":     m.ReceiptHandle,
					"body":              m.Body,
					"attributes":        attrs,
					"messageAttributes": map[string]any{},
					"md5OfBody":         md5hexLocal(m.Body),
					"eventSource":       "aws:sqs",
					"eventSourceARN":    sourceArn,
					"awsRegion":         "us-east-1",
				})
			}
			fnArn, _ := mapping["FunctionArn"].(string)
			fnParts := strings.Split(fnArn, ":")
			jobs = append(jobs, job{
				fnName:    fnParts[len(fnParts)-1],
				sourceArn: sourceArn,
				event:     string(respond.Marshal(map[string]any{"Records": records})),
				handles:   handles,
				queueURL:  queueURL,
			})
		}
	})

	for _, j := range jobs {
		outcome := l.Invoke(j.fnName, j.event, "sqs-esm", "")
		l.st.With(func(s *state.State) {
			q := s.SQS.Queues[j.queueURL]
			if q == nil {
				return
			}
			if outcome.Error == "" {
				sqs.RemoveByHandlesLocked(q, j.handles) // success → delete batch
			} else {
				for _, m := range q.Messages { // retry; repeated failures → DLQ
					if _, inBatch := j.handles[m.ReceiptHandle]; inBatch {
						m.Visible = true
						m.VisibleAt = 0
					}
				}
			}
		})
	}
}
