package controlplane

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/mockcloud/mockcloud/internal/config"
	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/services/dynamodb"
	"github.com/mockcloud/mockcloud/internal/services/lambda"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

var processStart = time.Now()

// SERVICES — the /mockcloud/health & /mockcloud/status services map
// (src/routes/status.js).
var services = []string{
	"s3", "dynamodb", "dynamodbstreams", "lambda", "iam", "sts",
	"sns", "sqs", "secretsmanager", "ec2",
	"events", "cloudwatch",
}

func servicesMap() map[string]string {
	m := make(map[string]string, len(services))
	for _, s := range services {
		m[s] = "available"
	}
	return m
}

// Deps is what route modules need — the store, disk-root config for reset's
// wipe semantics, and the Lambda/DynamoDB services (test hooks + reset).
type Deps struct {
	Store  *store.Store
	Cfg    *config.Config
	Lambda *lambda.Service
	DDB    *dynamodb.Service
}

func RegisterStatusRoutes(rt *Router, d Deps) {
	rt.Get("/mockcloud/health", func(w http.ResponseWriter, r *httpapi.Request) {
		respond.JSON(w, 200, map[string]any{
			"status":   "ok",
			"version":  config.Version,
			"daemon":   "mockcloud",
			"services": servicesMap(),
		})
	})

	rt.Get("/mockcloud/status", func(w http.ResponseWriter, r *httpapi.Request) {
		var body map[string]any
		d.Store.With(func(st *state.State) {
			ec2Running := 0
			for _, v := range st.EC2.Instances {
				if inst, ok := v.(map[string]any); ok && inst["state"] == "running" {
					ec2Running++
				}
			}
			var lambdaInvocations int64
			for _, f := range st.Lambda.Functions {
				lambdaInvocations += f.Invocations
			}
			s3Objects, s3Bytes := 0, int64(0)
			for _, b := range st.S3.Buckets {
				for _, o := range b.Objects {
					s3Objects++
					s3Bytes += o.Size
				}
			}
			ebRules := 0
			for _, bus := range st.EventBridge.Buses {
				ebRules += len(bus.Rules)
			}
			body = map[string]any{
				"healthy":  true,
				"uptime":   time.Since(processStart).Seconds(),
				"version":  config.Version,
				"services": servicesMap(),
				"stats": map[string]any{
					"ec2Running":        ec2Running,
					"ec2Total":          len(st.EC2.Instances),
					"lambdaFunctions":   len(st.Lambda.Functions),
					"lambdaInvocations": lambdaInvocations,
					"s3Buckets":         len(st.S3.Buckets),
					"s3Objects":         s3Objects,
					"s3Bytes":           s3Bytes,
					"dynamoTables":      len(st.DynamoDB.Tables),
					"snsTopics":         len(st.SNS.Topics),
					"sqsQueues":         len(st.SQS.Queues),
					"secrets":           len(st.SecretsManager.Secrets),
					"ebRules":           ebRules,
					"cwMetrics":         len(st.CloudWatch.Metrics),
					"trailEvents":       len(st.Trail),
				},
			}
		})
		respond.JSON(w, 200, body)
	})

	rt.Get("/mockcloud/trail", func(w http.ResponseWriter, r *httpapi.Request) {
		limit := 500
		if n, err := strconv.Atoi(r.Query.Get("limit")); err == nil {
			limit = n
		}
		var events []map[string]any
		d.Store.With(func(st *state.State) {
			if limit > len(st.Trail) || limit < 0 {
				limit = len(st.Trail)
			}
			events = append([]map[string]any{}, st.Trail[:limit]...)
		})
		respond.JSON(w, 200, map[string]any{"events": events})
	})

	rt.Delete("/mockcloud/trail", func(w http.ResponseWriter, r *httpapi.Request) {
		d.Store.With(func(st *state.State) { st.Trail = []map[string]any{} })
		respond.JSON(w, 200, map[string]any{"cleared": true})
	})

	rt.Delete("/mockcloud/reset", func(w http.ResponseWriter, r *httpapi.Request) {
		service := r.Query.Get("service")
		label := service
		if label == "" {
			label = "all"
		}
		body := map[string]any{"reset": label, "resetService": label}

		d.Store.With(func(st *state.State) { st.Reset(service) })

		// Wipe S3 disk so buckets don't resurrect on next restart.
		if service == "" || service == "s3" {
			if err := os.RemoveAll(d.Cfg.S3Root); err != nil {
				body["s3DiskError"] = err.Error()
			}
		}
		// Wipe the DynamoDB snapshot so reset tables don't resurrect either —
		// wipeDisk also cancels any pending debounced write and resets the
		// hydrate guard (src/services/dynamodb/persistence.js wipeDisk).
		if service == "" || service == "dynamodb" {
			d.DDB.WipeDisk()
		}
		respond.JSON(w, 200, body)
	})

	rt.Get("/mockcloud/export", func(w http.ResponseWriter, r *httpapi.Request) {
		var snap []byte
		var err error
		d.Store.With(func(st *state.State) { snap, err = st.Export() })
		if err != nil {
			fmt.Fprintf(os.Stderr, "[MockCloud] export failed: %v\n", err)
			respond.ErrorJSON(w, 500, "ExportError", err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", `attachment; filename="mockcloud-snapshot.json"`)
		w.WriteHeader(200)
		_, _ = w.Write(snap)
	})

	rt.Post("/mockcloud/import", func(w http.ResponseWriter, r *httpapi.Request) {
		// parsedBody yields {} for missing/invalid/non-JSON-CT bodies — reject
		// those explicitly instead of silently no-oping.
		if len(r.ParsedBody) == 0 {
			respond.ErrorJSON(w, 400, "ValidationError", "body must be a JSON snapshot as produced by GET /mockcloud/export")
			return
		}
		var impErr error
		d.Store.With(func(st *state.State) { impErr = st.Import(r.RawBody) })
		if impErr != nil {
			respond.ErrorJSON(w, 400, "ValidationError", "invalid snapshot: "+impErr.Error())
			return
		}
		respond.JSON(w, 200, map[string]any{"imported": true})
	})
}
