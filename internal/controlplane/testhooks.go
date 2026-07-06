package controlplane

import (
	"errors"
	"fmt"
	"net/http"
	"os"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/services/eventbridge"
	"github.com/mockcloud/mockcloud/internal/state"
)

// RegisterTestRoutes — the /mockcloud/_test/* endpoints (MOCKCLOUD_TEST_ENDPOINTS=1
// only; see src/routes/_test.js for the contract).
func RegisterTestRoutes(rt *Router, d Deps, eb *eventbridge.Service) {
	// Replaces: fireDueSchedulesOnce(Date.now() + advanceMs). The offset is
	// relative so the test and server clocks never need to agree. The sweep
	// (and its SQS deliveries) completes before the response is written.
	rt.Post("/mockcloud/_test/eventbridge/fire-schedules", func(w http.ResponseWriter, r *httpapi.Request) {
		// Number(req.parsedBody?.advanceMs) || 0
		advanceMs, ok := httpapi.Num(r.ParsedBody, "advanceMs")
		if !ok {
			if s, isStr := r.ParsedBody["advanceMs"].(string); isStr {
				if f := jsnum.ToNumberFromString(s); f == f { // not NaN
					advanceMs = f
				}
			}
		}
		eb.FireDueSchedulesOnce(state.NowMs() + int64(advanceMs))
		respond.JSON(w, 200, map[string]any{"ok": true})
	})
	// Replaces: persistNow() — force the debounced snapshot to disk now.
	rt.Post("/mockcloud/_test/dynamodb/persist", func(w http.ResponseWriter, r *httpapi.Request) {
		d.DDB.PersistNow()
		respond.JSON(w, 200, map[string]any{"persisted": true})
	})

	// Replaces: existsSync(<DDB_ROOT>/tables.json).
	rt.Get("/mockcloud/_test/dynamodb/snapshot", func(w http.ResponseWriter, r *httpapi.Request) {
		respond.JSON(w, 200, map[string]any{"exists": d.DDB.SnapshotExists()})
	})

	// Replaces: store.reset('dynamodb'); hydrateFromDisk(true) — simulates a
	// restart: drop the in-memory namespace, force-rehydrate from disk.
	rt.Post("/mockcloud/_test/dynamodb/reload", func(w http.ResponseWriter, r *httpapi.Request) {
		d.Store.With(func(st *state.State) { st.Reset("dynamodb") })
		d.DDB.HydrateFromDisk(true)
		respond.JSON(w, 200, map[string]any{"tables": d.DDB.TableNames()})
	})
	// Exercises the production error boundary black-box: JSON __type shape for
	// JSON-protocol requests, S3 <Error> XML otherwise.
	rt.Get("/mockcloud/_test/boom", func(w http.ResponseWriter, r *httpapi.Request) {
		err := errors.New("boom (MOCKCLOUD_TEST_ENDPOINTS)")
		fmt.Fprintf(os.Stderr, "[MockCloud] Unhandled error: %v\n", err)
		respond.SendInternalError(w, r.Request, false)
	})

	// The internal (non-API) invocation path — replaces tests' direct
	// invokeLambda import. Returns the result object verbatim:
	// { result, duration, error, requestId } with JS-null semantics.
	rt.Post("/mockcloud/_test/lambda/internal-invoke", func(w http.ResponseWriter, r *httpapi.Request) {
		body := r.ParsedBody
		fnName := httpapi.Str(body, "functionName")
		if fnName == "" {
			respond.ErrorJSON(w, 400, "ValidationError", "functionName is required")
			return
		}
		source := httpapi.Str(body, "source")
		if source == "" {
			source = "test"
		}
		payload := "{}"
		if raw, ok := body["payload"]; ok && raw != nil {
			if s, isStr := raw.(string); isStr {
				payload = s
			} else {
				payload = string(respond.Marshal(raw))
			}
		}
		out := d.Lambda.Invoke(fnName, payload, source, "")
		resp := map[string]any{
			"result": nil, "duration": out.Duration, "error": nil, "requestId": out.RequestID,
		}
		if out.Result != "" {
			resp["result"] = out.Result
		}
		if out.Error != "" {
			resp["error"] = out.Error
		}
		respond.JSON(w, 200, resp)
	})
}
