package sqs

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

func jsonUnmarshal(s string, v any) error {
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	return dec.Decode(v)
}

func errJSON(w http.ResponseWriter, code, message string) {
	respond.JSON(w, 400, map[string]string{"__type": code, "message": message})
}

// numOr honours JS ?? semantics: absent → default, present 0 → 0.
func numOr(m map[string]any, key string, def float64) float64 {
	if v, ok := httpapi.Num(m, key); ok {
		return v
	}
	return def
}

func attrsOf(payload map[string]any, key string) map[string]any {
	if a, ok := payload[key].(map[string]any); ok {
		return a
	}
	return nil
}

// handleJSON — the AmazonSQS.* target protocol (what SDK v3 speaks). Long
// polling lives ONLY here, as in Node.
func handleJSON(w http.ResponseWriter, r *httpapi.Request, st *store.Store, action string, payload map[string]any) {
	qurl := httpapi.Str(payload, "QueueUrl")

	switch action {
	case "CreateQueue":
		name := httpapi.Str(payload, "QueueName")
		u := queueURLFor(name)
		st.With(func(s *state.State) {
			if s.SQS.Queues[u] == nil {
				qType := "standard"
				if strings.HasSuffix(name, ".fifo") {
					qType = "fifo"
				}
				attrs := map[string]string{}
				if raw, ok := payload["Attributes"].(map[string]any); ok {
					for k, v := range raw {
						if sv, ok := v.(string); ok {
							attrs[k] = sv
						}
					}
				}
				s.SQS.Queues[u] = &state.Queue{
					Name: name, URL: u, Arn: state.Arn("sqs", name), Type: qType,
					Attributes: attrs, Messages: []*state.Message{}, Created: state.NowMs(),
				}
				s.AddTrail(map[string]any{"method": "POST", "path": "/sqs/CreateQueue/" + name, "status": 200, "latency": 2})
			}
		})
		respond.JSON(w, 200, map[string]any{"QueueUrl": u})

	case "GetQueueUrl":
		u := queueURLFor(httpapi.Str(payload, "QueueName"))
		if !queueExists(st, u) {
			errJSON(w, "QueueDoesNotExist", "Queue not found")
			return
		}
		respond.JSON(w, 200, map[string]any{"QueueUrl": u})

	case "GetQueueAttributes":
		var missing bool
		attrs := map[string]string{}
		st.With(func(s *state.State) {
			q := s.SQS.Queues[qurl]
			if q == nil {
				missing = true
				return
			}
			surfaceExpired(q)
			visible, notVisible := 0, 0
			for _, m := range q.Messages {
				if m.Visible {
					visible++
				} else {
					notVisible++
				}
			}
			// JSON path adds string-typed defaults (unlike XML).
			attrs = map[string]string{
				"QueueArn":                              q.Arn,
				"ApproximateNumberOfMessages":           strconv.Itoa(visible),
				"ApproximateNumberOfMessagesNotVisible": strconv.Itoa(notVisible),
				"ApproximateNumberOfMessagesDelayed":    "0",
				"VisibilityTimeout":                     "30",
				"MaximumMessageSize":                    "262144",
				"MessageRetentionPeriod":                "86400",
				"ReceiveMessageWaitTimeSeconds":         "0",
				"SqsManagedSseEnabled":                  "true",
			}
			for k, v := range q.Attributes {
				attrs[k] = v
			}
		})
		if missing {
			errJSON(w, "QueueDoesNotExist", "Queue not found")
			return
		}
		respond.JSON(w, 200, map[string]any{"Attributes": attrs})

	case "SetQueueAttributes":
		var missing bool
		st.With(func(s *state.State) {
			q := s.SQS.Queues[qurl]
			if q == nil {
				missing = true
				return
			}
			if raw, ok := payload["Attributes"].(map[string]any); ok {
				for k, v := range raw {
					if sv, ok := v.(string); ok {
						q.Attributes[k] = sv
					}
				}
			}
		})
		if missing {
			errJSON(w, "QueueDoesNotExist", "Queue not found")
			return
		}
		respond.JSON(w, 200, map[string]any{})

	case "ListQueues":
		urls := []string{}
		st.With(func(s *state.State) {
			for u := range s.SQS.Queues {
				urls = append(urls, u)
			}
		})
		respond.JSON(w, 200, map[string]any{"QueueUrls": urls})

	case "DeleteQueue":
		st.With(func(s *state.State) {
			q := s.SQS.Queues[qurl]
			qName := ""
			if q != nil {
				qName = q.Name
			} else {
				parts := strings.Split(qurl, "/")
				qName = parts[len(parts)-1]
			}
			delete(s.SQS.Queues, qurl)
			s.AddTrail(map[string]any{"method": "POST", "path": "/sqs/DeleteQueue/" + qName, "status": 200, "latency": 1})
		})
		respond.JSON(w, 200, map[string]any{})

	case "PurgeQueue":
		st.With(func(s *state.State) {
			if q := s.SQS.Queues[qurl]; q != nil {
				q.Messages = []*state.Message{}
			}
		})
		respond.JSON(w, 200, map[string]any{})

	case "SendMessage":
		var missing, missingGroup, fifo bool
		var msg *state.Message
		body := httpapi.Str(payload, "MessageBody")
		attrs := attrsOf(payload, "MessageAttributes")
		st.With(func(s *state.State) {
			q := s.SQS.Queues[qurl]
			if q == nil {
				missing = true
				return
			}
			if q.Type == "fifo" && httpapi.Str(payload, "MessageGroupId") == "" {
				missingGroup = true
				return
			}
			fifo = q.Type == "fifo"
			msg = EnqueueLocked(s, qurl, body, enqueueOpts{
				dedupeID:     httpapi.Str(payload, "MessageDeduplicationId"),
				groupID:      httpapi.Str(payload, "MessageGroupId"),
				delaySeconds: numOr(payload, "DelaySeconds", 0),
				attributes:   attrs,
			})
		})
		if missing {
			errJSON(w, "QueueDoesNotExist", "Queue not found")
			return
		}
		if missingGroup {
			errJSON(w, "MissingParameter", "The request must contain the parameter MessageGroupId.")
			return
		}
		out := map[string]any{"MessageId": msg.ID, "MD5OfMessageBody": md5hex(body)}
		if hasAttributes(attrs) {
			out["MD5OfMessageAttributes"] = md5OfMessageAttributes(attrs)
		}
		if fifo {
			out["SequenceNumber"] = msg.SequenceNumber
		}
		respond.JSON(w, 200, out)

	case "SendMessageBatch":
		var missing bool
		successful := []map[string]any{}
		failed := []map[string]any{}
		st.With(func(s *state.State) {
			q := s.SQS.Queues[qurl]
			if q == nil {
				missing = true
				return
			}
			entries, _ := payload["Entries"].([]any)
			for _, raw := range entries {
				e, _ := raw.(map[string]any)
				if e == nil {
					continue
				}
				if q.Type == "fifo" && httpapi.Str(e, "MessageGroupId") == "" {
					failed = append(failed, map[string]any{
						"Id": e["Id"], "Code": "MissingParameter",
						"Message": "The request must contain the parameter MessageGroupId.", "SenderFault": true,
					})
					continue
				}
				body := httpapi.Str(e, "MessageBody")
				eAttrs := attrsOf(e, "MessageAttributes")
				msg := EnqueueLocked(s, qurl, body, enqueueOpts{
					dedupeID:     httpapi.Str(e, "MessageDeduplicationId"),
					groupID:      httpapi.Str(e, "MessageGroupId"),
					delaySeconds: numOr(e, "DelaySeconds", 0),
					attributes:   eAttrs,
				})
				entry := map[string]any{"Id": e["Id"], "MessageId": msg.ID, "MD5OfMessageBody": md5hex(body)}
				if hasAttributes(eAttrs) {
					entry["MD5OfMessageAttributes"] = md5OfMessageAttributes(eAttrs)
				}
				if q.Type == "fifo" {
					entry["SequenceNumber"] = msg.SequenceNumber
				}
				successful = append(successful, entry)
			}
		})
		if missing {
			errJSON(w, "QueueDoesNotExist", "Queue not found")
			return
		}
		respond.JSON(w, 200, map[string]any{"Successful": successful, "Failed": failed})

	case "ReceiveMessage":
		maxMsgs := int(numOr(payload, "MaxNumberOfMessages", 0))
		if maxMsgs == 0 {
			maxMsgs = 1 // Node: payload.MaxNumberOfMessages || 1
		}
		visMs := int64(numOr(payload, "VisibilityTimeout", 30) * 1000)
		var missing bool
		var out []map[string]any
		var waitSec float64
		attempt := func(first bool) bool { // returns done
			done := true
			st.With(func(s *state.State) {
				q := s.SQS.Queues[qurl]
				if q == nil {
					if first {
						missing = true
					}
					return // queue gone: bail with whatever we have (empty)
				}
				if first {
					// WaitTimeSeconds ?? queue attr ?? 0, capped at 20.
					if v, ok := httpapi.Num(payload, "WaitTimeSeconds"); ok {
						waitSec = v
					} else if av, err := strconv.ParseFloat(q.Attributes["ReceiveMessageWaitTimeSeconds"], 64); err == nil {
						waitSec = av
					}
					if waitSec > 20 {
						waitSec = 20
					}
				}
				msgs := selectMessages(s, q, maxMsgs)
				if len(msgs) == 0 {
					done = false
					return
				}
				for _, m := range msgs {
					hideMessage(m, visMs)
				}
				out = make([]map[string]any, 0, len(msgs))
				for _, m := range msgs {
					count := m.ApproxReceiveCount
					if count == 0 {
						count = 1
					}
					attrs := map[string]any{
						"ApproximateReceiveCount": strconv.Itoa(count),
						"SentTimestamp":           strconv.FormatInt(m.Sent, 10),
					}
					if q.Type == "fifo" {
						attrs["MessageGroupId"] = m.GroupID
						attrs["SequenceNumber"] = m.SequenceNumber
						if m.DedupeID != nil {
							attrs["MessageDeduplicationId"] = *m.DedupeID
						}
					}
					msgOut := map[string]any{
						"MessageId": m.ID, "ReceiptHandle": m.ReceiptHandle,
						"Body": m.Body, "MD5OfBody": md5hex(m.Body), "Attributes": attrs,
					}
					if hasAttributes(m.MessageAttributes) {
						msgOut["MessageAttributes"] = m.MessageAttributes
						msgOut["MD5OfMessageAttributes"] = md5OfMessageAttributes(m.MessageAttributes)
					}
					out = append(out, msgOut)
				}
			})
			return done
		}

		got := attempt(true)
		if missing {
			errJSON(w, "QueueDoesNotExist", "Queue not found")
			return
		}
		if !got && waitSec > 0 {
			// Long polling: Node's 50ms re-check loop, lock released each cycle,
			// bailing if the queue is deleted mid-wait.
			deadline := time.Now().Add(time.Duration(waitSec * float64(time.Second)))
			for time.Now().Before(deadline) {
				time.Sleep(50 * time.Millisecond)
				if attempt(false) {
					break
				}
				if !queueExists(st, qurl) {
					break
				}
			}
		}
		if out == nil {
			out = []map[string]any{}
		}
		respond.JSON(w, 200, map[string]any{"Messages": out})

	case "DeleteMessage":
		st.With(func(s *state.State) {
			if q := s.SQS.Queues[qurl]; q != nil {
				removeByHandle(q, httpapi.Str(payload, "ReceiptHandle"))
			}
		})
		respond.JSON(w, 200, map[string]any{})

	case "DeleteMessageBatch":
		var missing bool
		successful := []map[string]any{}
		failed := []map[string]any{}
		st.With(func(s *state.State) {
			q := s.SQS.Queues[qurl]
			if q == nil {
				missing = true
				return
			}
			entries, _ := payload["Entries"].([]any)
			for _, raw := range entries {
				e, _ := raw.(map[string]any)
				if e == nil {
					continue
				}
				if removeByHandle(q, httpapi.Str(e, "ReceiptHandle")) {
					successful = append(successful, map[string]any{"Id": e["Id"]})
				} else {
					failed = append(failed, map[string]any{
						"Id": e["Id"], "Code": "ReceiptHandleIsInvalid",
						"Message": "The receipt handle does not match any message.", "SenderFault": true,
					})
				}
			}
		})
		if missing {
			errJSON(w, "QueueDoesNotExist", "Queue not found")
			return
		}
		respond.JSON(w, 200, map[string]any{"Successful": successful, "Failed": failed})

	case "ChangeMessageVisibility":
		var missing, badHandle bool
		st.With(func(s *state.State) {
			q := s.SQS.Queues[qurl]
			if q == nil {
				missing = true
				return
			}
			m := findByHandle(q, httpapi.Str(payload, "ReceiptHandle"))
			if m == nil {
				badHandle = true
				return
			}
			setInvisible(m, int64(numOr(payload, "VisibilityTimeout", 30)*1000))
		})
		if missing {
			errJSON(w, "QueueDoesNotExist", "Queue not found")
			return
		}
		if badHandle {
			errJSON(w, "ReceiptHandleIsInvalid", "The receipt handle does not match any message.")
			return
		}
		respond.JSON(w, 200, map[string]any{})

	case "ChangeMessageVisibilityBatch":
		var missing bool
		successful := []map[string]any{}
		failed := []map[string]any{}
		st.With(func(s *state.State) {
			q := s.SQS.Queues[qurl]
			if q == nil {
				missing = true
				return
			}
			entries, _ := payload["Entries"].([]any)
			for _, raw := range entries {
				e, _ := raw.(map[string]any)
				if e == nil {
					continue
				}
				m := findByHandle(q, httpapi.Str(e, "ReceiptHandle"))
				if m == nil {
					failed = append(failed, map[string]any{
						"Id": e["Id"], "Code": "ReceiptHandleIsInvalid",
						"Message": "The receipt handle does not match any message.", "SenderFault": true,
					})
					continue
				}
				setInvisible(m, int64(numOr(e, "VisibilityTimeout", 30)*1000))
				successful = append(successful, map[string]any{"Id": e["Id"]})
			}
		})
		if missing {
			errJSON(w, "QueueDoesNotExist", "Queue not found")
			return
		}
		respond.JSON(w, 200, map[string]any{"Successful": successful, "Failed": failed})

	default:
		errJSON(w, "InvalidAction", "Unknown SQS action: "+action)
	}
}
