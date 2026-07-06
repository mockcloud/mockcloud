package controlplane

import (
	"errors"
	"fmt"
	"net/http"
	"os"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
)

// RegisterTestRoutes — the /mockcloud/_test/* endpoints (MOCKCLOUD_TEST_ENDPOINTS=1
// only; see src/routes/_test.js for the contract). Endpoints whose services
// haven't been ported yet are registered by those services' milestones:
//   - _test/eventbridge/fire-schedules → M7
//   - _test/dynamodb/{persist,snapshot,reload} → M4
//   - _test/lambda/internal-invoke → M6
func RegisterTestRoutes(rt *Router, d Deps) {
	// Exercises the production error boundary black-box: JSON __type shape for
	// JSON-protocol requests, S3 <Error> XML otherwise.
	rt.Get("/mockcloud/_test/boom", func(w http.ResponseWriter, r *httpapi.Request) {
		err := errors.New("boom (MOCKCLOUD_TEST_ENDPOINTS)")
		fmt.Fprintf(os.Stderr, "[MockCloud] Unhandled error: %v\n", err)
		respond.SendInternalError(w, r.Request, false)
	})
}
