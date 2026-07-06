// MockCloud daemon — Go implementation (port of src/index.js).
package main

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/mockcloud/mockcloud/internal/background"
	"github.com/mockcloud/mockcloud/internal/config"
	"github.com/mockcloud/mockcloud/internal/controlplane"
	"github.com/mockcloud/mockcloud/internal/dispatch"
	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/services/dynamodb"
	"github.com/mockcloud/mockcloud/internal/services/lambda"
	"github.com/mockcloud/mockcloud/internal/services/s3"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

func main() {
	cfg := config.Load()
	st := store.New()
	cors := httpapi.NewCORS(cfg)
	lambdaSvc := lambda.New(st, cfg)
	s3Svc := s3.New(st, cfg)
	s3Svc.HydrateFromDisk() // pre-existing buckets/objects survive restarts
	ddbSvc := dynamodb.New(st, cfg)
	ddbSvc.HydrateFromDisk(false) // tables snapshot survives restarts too
	disp := dispatch.New(st, cfg, lambdaSvc, s3Svc, ddbSvc)

	router := &controlplane.Router{}
	deps := controlplane.Deps{Store: st, Cfg: cfg, Lambda: lambdaSvc, DDB: ddbSvc}
	controlplane.RegisterStatusRoutes(router, deps)
	ddbSvc.RegisterUIRoutes(func(method, pattern string, h func(http.ResponseWriter, *httpapi.Request)) {
		router.Add(method, pattern, h)
	})
	if cfg.TestEndpoints {
		controlplane.RegisterTestRoutes(router, deps)
	}

	// ── AWS API listener ────────────────────────────────────────────────
	// No ServeMux — it path-cleans // and .., which corrupts S3 keys. One
	// handler reproducing src/index.js's order: CORS → body → control plane →
	// (SigV4/IAM opt-ins, M9) → AWS dispatch, inside the error boundary.
	awsHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if e := recover(); e != nil {
				fmt.Fprintf(os.Stderr, "[MockCloud] Unhandled error: %v\n", e)
				respond.SendInternalError(w, r, false)
			}
		}()
		if !cors.Apply(w, r) {
			return
		}
		req := httpapi.Attach(r)
		if router.Dispatch(w, req) {
			return
		}
		disp.Dispatch(w, req)
	})

	ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", cfg.Host, cfg.Port))
	if err != nil {
		fmt.Fprintf(os.Stderr, "mockcloud: cannot listen on %s:%d: %v\n", cfg.Host, cfg.Port, err)
		os.Exit(1)
	}
	boundPort := ln.Addr().(*net.TCPAddr).Port
	awsServer := &http.Server{Handler: awsHandler}
	go func() { _ = awsServer.Serve(ln) }()

	// ── UI static server (embed lands in M10; serve ui/dist when present) ──
	var uiServer *http.Server
	if cfg.UIOn {
		if dist, err := filepath.Abs("ui/dist"); err == nil {
			if _, err := os.Stat(dist); err == nil {
				uiServer = &http.Server{
					Addr:    fmt.Sprintf("%s:%d", cfg.Host, cfg.UIPort),
					Handler: uiHandler(dist),
				}
				go func() { _ = uiServer.ListenAndServe() }()
			}
		}
	}

	// ── Banner + machine-readable readiness line (keep the format stable —
	// the test harness greps for it) ───────────────────────────────────────
	fmt.Printf("\n  ╭─────────────────────────────────────────────────╮\n")
	fmt.Printf("  │   ☁  MockCloud  v%-30s│\n", config.Version+" (go)")
	fmt.Printf("  │   AWS API  →  http://%s:%d             │\n", cfg.Host, boundPort)
	if uiServer != nil {
		fmt.Printf("  │   Console  →  http://%s:%d             │\n", cfg.Host, cfg.UIPort)
	}
	fmt.Printf("  │   github.com/mockcloud/mockcloud                │\n")
	fmt.Printf("  ╰─────────────────────────────────────────────────╯\n\n")
	readyHost := cfg.Host
	if readyHost == "0.0.0.0" {
		readyHost = "127.0.0.1"
	}
	fmt.Printf("MOCKCLOUD_READY endpoint=http://%s:%d\n", readyHost, boundPort)

	// ── Background ticks (SQS→Lambda ESM lands M6, schedules M7) ─────────
	ticker := background.New(cfg.PollIntervalMs)
	ticker.Register(cloudWatchCollector(st))
	ticker.Start()

	// ── Orphan protection: exit when the supervising pipe closes ─────────
	if cfg.ExitOnStdinEOF {
		go func() {
			r := bufio.NewReader(os.Stdin)
			buf := make([]byte, 256)
			for {
				if _, err := r.Read(buf); err != nil {
					os.Exit(0)
				}
			}
		}()
	}

	// ── Signals ───────────────────────────────────────────────────────────
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	// Flush a pending debounced DynamoDB snapshot so a Ctrl+C right after a
	// write doesn't lose data (persistence.js SIGINT/SIGTERM flush).
	ddbSvc.FlushPendingSnapshot()
	ticker.Stop()
	_ = awsServer.Close()
	if uiServer != nil {
		_ = uiServer.Close()
	}
}

// cloudWatchCollector — the 60s-throttled metrics tick from src/store.js.
func cloudWatchCollector(st *store.Store) func() {
	var lastMetricsAt int64
	return func() {
		now := state.NowMs()
		if now-lastMetricsAt < 60_000 {
			return
		}
		lastMetricsAt = now
		st.With(func(s *state.State) {
			var invocations, errors float64
			for _, f := range s.Lambda.Functions {
				invocations += float64(f.Invocations)
				errors += float64(f.Errors)
			}
			objects, bytes := 0.0, 0.0
			for _, b := range s.S3.Buckets {
				for _, o := range b.Objects {
					objects++
					bytes += float64(o.Size)
				}
			}
			messages := 0.0
			for _, q := range s.SQS.Queues {
				messages += float64(len(q.Messages))
			}
			running := 0.0
			for _, v := range s.EC2.Instances {
				if inst, ok := v.(map[string]any); ok && inst["state"] == "running" {
					running++
				}
			}
			s.PutMetric("MockCloud/Lambda", "Invocations", invocations, "")
			s.PutMetric("MockCloud/Lambda", "Errors", errors, "")
			s.PutMetric("MockCloud/S3", "NumberOfObjects", objects, "")
			s.PutMetric("MockCloud/S3", "BucketSizeBytes", bytes, "")
			s.PutMetric("MockCloud/SQS", "NumberOfMessagesSent", messages, "")
			s.PutMetric("MockCloud/DynamoDB", "SuccessfulRequestLatency", 3, "")
			s.PutMetric("MockCloud/EC2", "RunningInstances", running, "")
		})
	}
}

// uiHandler serves the prebuilt console with SPA fallback (src/index.js's
// UI server). go:embed replaces this in M10.
func uiHandler(dist string) http.Handler {
	mimes := map[string]string{
		".html": "text/html", ".js": "application/javascript", ".css": "text/css",
		".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
		".json": "application/json", ".woff2": "font/woff2",
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		rel := strings.TrimPrefix(r.URL.Path, "/")
		fp := filepath.Join(dist, filepath.FromSlash(rel))
		// Containment: resolved path must stay inside dist (safeJoin).
		if rel == "" || !strings.HasPrefix(fp, dist) {
			fp = filepath.Join(dist, "index.html")
		}
		if _, err := os.Stat(fp); err != nil {
			fp = filepath.Join(dist, "index.html")
		}
		content, err := os.ReadFile(fp)
		if err != nil {
			w.WriteHeader(404)
			_, _ = w.Write([]byte("Not found"))
			return
		}
		ct := mimes[filepath.Ext(fp)]
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(200)
		_, _ = w.Write(content)
	})
}
