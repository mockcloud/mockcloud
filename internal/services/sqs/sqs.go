// Package sqs — port of src/services/sqs.js.
//
// M1 scope: JSON protocol (x-amz-target: AmazonSQS.*) CreateQueue /
// ListQueues only. The query/XML protocol, messaging, FIFO, visibility and
// DLQ semantics land in M5.
package sqs

import (
	"net/http"
	"strings"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

const account = "000000000000"

func queueURLFor(name string) string {
	return "http://localhost:4566/" + account + "/" + name
}

func Handler(w http.ResponseWriter, r *httpapi.Request, st *store.Store) {
	target := r.Header.Get("x-amz-target")
	if strings.HasPrefix(target, "AmazonSQS.") {
		action := strings.SplitN(target, ".", 2)[1]
		handleJSON(w, r, st, action, r.JSONBody())
		return
	}
	// Query/XML protocol — M5.
	respond.ErrorXML(w, 400, "NotImplemented", "MockCloud Go port: SQS query protocol not yet ported (M5)")
}

func handleJSON(w http.ResponseWriter, r *httpapi.Request, st *store.Store, action string, payload map[string]any) {
	switch action {
	case "CreateQueue":
		name := httpapi.Str(payload, "QueueName")
		url := queueURLFor(name)
		a := state.Arn("sqs", name)
		st.With(func(s *state.State) {
			if _, exists := s.SQS.Queues[url]; !exists {
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
				s.SQS.Queues[url] = &state.Queue{
					Name: name, URL: url, Arn: a, Type: qType,
					Attributes: attrs, Messages: []map[string]any{}, Created: state.NowMs(),
				}
				s.AddTrail(map[string]any{"method": "POST", "path": "/sqs/CreateQueue/" + name, "status": 200, "latency": 2})
			}
		})
		respond.JSON(w, 200, map[string]any{"QueueUrl": url})

	case "ListQueues":
		var urls []string
		st.With(func(s *state.State) {
			urls = make([]string, 0, len(s.SQS.Queues))
			for u := range s.SQS.Queues {
				urls = append(urls, u)
			}
		})
		respond.JSON(w, 200, map[string]any{"QueueUrls": urls})

	default:
		respond.ErrorJSON(w, 400, "NotImplemented", "MockCloud Go port: SQS action "+action+" not yet ported (M5)")
	}
}
