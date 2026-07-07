// MockCloud daemon — Go implementation (port of src/index.js).
package main

import (
	"bufio"
	"fmt"
	"io/fs"
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
	"github.com/mockcloud/mockcloud/internal/iampolicy"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/services/bedrock"
	"github.com/mockcloud/mockcloud/internal/services/dynamodb"
	"github.com/mockcloud/mockcloud/internal/services/ec2"
	"github.com/mockcloud/mockcloud/internal/services/eventbridge"
	"github.com/mockcloud/mockcloud/internal/services/iam"
	"github.com/mockcloud/mockcloud/internal/services/lambda"
	"github.com/mockcloud/mockcloud/internal/services/s3"
	"github.com/mockcloud/mockcloud/internal/services/secretsmanager"
	"github.com/mockcloud/mockcloud/internal/services/ses"
	"github.com/mockcloud/mockcloud/internal/sigv4"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
	"github.com/mockcloud/mockcloud/ui"
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
	ebSvc := eventbridge.New(st)
	sesSvc := ses.New(st, cfg)
	ec2Svc := ec2.New(st)
	iamSvc := iam.New(st)
	smSvc := secretsmanager.New(st)
	bedrockSvc := bedrock.New(st)
	disp := dispatch.New(st, cfg, lambdaSvc, s3Svc, ddbSvc, ebSvc, sesSvc, ec2Svc, iamSvc, smSvc, bedrockSvc)

	// Opt-in security middleware (src/index.js: SigV4 then IAM, before dispatch).
	sigv4Enabled := cfg.VerifySigV4
	iamMode := iampolicy.Mode()
	// Resolve access-key-id → owning username for IAM principal derivation
	// without the iampolicy package importing store just for the map read.
	iampolicy.SetOwnerLookup(func(akid string) string {
		var owner string
		st.With(func(s *state.State) {
			if s.IAM.AccessKeyOwners != nil {
				owner = s.IAM.AccessKeyOwners[akid]
			}
		})
		return owner
	})

	// /mockcloud/* control plane — registration follows src/routes/index.js
	// order (status, s3, dynamo, lambda, ec2, secrets, iam, terminal, ses).
	router := &controlplane.Router{}
	deps := controlplane.Deps{Store: st, Cfg: cfg, Lambda: lambdaSvc, DDB: ddbSvc}
	add := func(method, pattern string, h func(http.ResponseWriter, *httpapi.Request)) {
		router.Add(method, pattern, h)
	}
	controlplane.RegisterStatusRoutes(router, deps)
	controlplane.RegisterS3UIRoutes(router, deps)
	ddbSvc.RegisterUIRoutes(add)
	lambdaSvc.RegisterUIRoutes(add)
	ec2Svc.RegisterUIRoutes(add)
	smSvc.RegisterUIRoutes(add)
	iamSvc.RegisterUIRoutes(add)
	controlplane.RegisterTerminalRoutes(router, deps)
	sesSvc.RegisterUIRoutes(add)
	bedrockSvc.RegisterUIRoutes(add)
	if cfg.TestEndpoints {
		controlplane.RegisterTestRoutes(router, deps, ebSvc)
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
		// Opt-in SigV4 verification then IAM enforcement, before AWS dispatch —
		// /mockcloud/* routes above are internal and exempt (src/index.js order).
		if sigv4Enabled {
			if err := sigv4.Verify(req, st); err != nil {
				sigv4.SendError(w, req, err)
				return
			}
		}
		if iamMode != "off" {
			if err := iampolicy.Enforce(req, st); err != nil {
				iampolicy.SendError(w, req, err)
				return
			}
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

	// ── UI static server ─────────────────────────────────────────────────
	// Source the console from, in order: the binary itself (release builds,
	// -tags embedui), MOCKCLOUD_UI_DIR (dev override), or ./ui/dist on disk.
	var uiServer *http.Server
	if cfg.UIOn {
		if fsys := resolveUIFS(); fsys != nil {
			uiServer = &http.Server{
				Addr:    fmt.Sprintf("%s:%d", cfg.Host, cfg.UIPort),
				Handler: uiHandler(fsys),
			}
			go func() { _ = uiServer.ListenAndServe() }()
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

	// ── Background ticks ──────────────────────────────────────────────────
	ticker := background.New(cfg.PollIntervalMs)
	ticker.Register(cloudWatchCollector(st))
	ticker.Register(lambdaSvc.PollEventSourceMappingsOnce) // SQS→Lambda ESM
	ticker.Register(func() { ebSvc.FireDueSchedulesOnce(state.NowMs()) })
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

// resolveUIFS returns the console filesystem, or nil when no UI is available:
// the embedded dist (release builds, -tags embedui), else MOCKCLOUD_UI_DIR,
// else ./ui/dist on disk.
func resolveUIFS() fs.FS {
	if embedded, ok := ui.DistFS(); ok {
		return embedded
	}
	dir := os.Getenv("MOCKCLOUD_UI_DIR")
	if dir == "" {
		dir = "ui/dist"
	}
	if abs, err := filepath.Abs(dir); err == nil {
		if info, err := os.Stat(abs); err == nil && info.IsDir() {
			return os.DirFS(abs)
		}
	}
	return nil
}

// uiHandler serves the prebuilt console (fs.FS) with SPA fallback — the
// io/fs port of src/index.js's UI server. fs.FS forbids path escapes, so it
// replaces the old safeJoin containment check.
func uiHandler(fsys fs.FS) http.Handler {
	mimes := map[string]string{
		".html": "text/html", ".js": "application/javascript", ".css": "text/css",
		".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
		".json": "application/json", ".woff2": "font/woff2",
	}
	read := func(name string) ([]byte, string, bool) {
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			return nil, "", false
		}
		ct := mimes[strings.ToLower(filepath.Ext(name))]
		if ct == "" {
			ct = "application/octet-stream"
		}
		return data, ct, true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" || !fs.ValidPath(name) {
			name = "index.html"
		}
		data, ct, ok := read(name)
		if !ok {
			// SPA fallback.
			data, ct, ok = read("index.html")
			if !ok {
				w.WriteHeader(404)
				_, _ = w.Write([]byte("Not found"))
				return
			}
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(200)
		_, _ = w.Write(data)
	})
}
