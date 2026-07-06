package httpapi

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/mockcloud/mockcloud/internal/config"
)

// CORS gate — port of applyCors (src/middleware/http.js). Returns true when
// the handler should continue; false when a response was already written
// (preflight or rejection).
type CORS struct {
	allowed map[string]struct{}
}

func NewCORS(cfg *config.Config) *CORS {
	allowed := map[string]struct{}{}
	for _, host := range []string{"localhost", "127.0.0.1"} {
		for _, port := range []int{cfg.Port, cfg.UIPort} {
			allowed[fmt.Sprintf("http://%s:%d", host, port)] = struct{}{}
		}
	}
	for _, o := range cfg.AllowedOrigins {
		allowed[o] = struct{}{}
	}
	return &CORS{allowed: allowed}
}

var mutating = map[string]struct{}{"POST": {}, "PUT": {}, "PATCH": {}, "DELETE": {}}

func scopeOf(path string) string {
	if strings.HasPrefix(path, "/mockcloud/terminal/") || path == "/mockcloud/terminal" {
		return "terminal"
	}
	if strings.HasPrefix(path, "/mockcloud/") {
		return "ui"
	}
	return "aws"
}

func (c *CORS) Apply(w http.ResponseWriter, r *http.Request) bool {
	// Node matched scope against req.url (path + query, raw).
	scope := scopeOf(r.URL.EscapedPath())
	origin := r.Header.Get("Origin")
	_, ok := c.allowed[origin]

	h := w.Header()
	if origin != "" {
		h.Set("Vary", "Origin")
		if ok {
			h.Set("Access-Control-Allow-Origin", origin)
		}
	} else {
		h.Set("Access-Control-Allow-Origin", "*")
	}
	h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS")
	h.Set("Access-Control-Allow-Headers",
		"Content-Type, Authorization, X-Amz-Target, X-Amz-Date, X-Amz-Security-Token, X-Amz-Content-Sha256, X-Api-Key, X-Amz-User-Agent")
	h.Set("Access-Control-Expose-Headers", "ETag, x-amz-request-id, x-amz-id-2, x-amz-version-id")

	// UI / terminal preflight answered here; aws-scope OPTIONS falls through
	// to the S3 handler (per-bucket CORS rules).
	if r.Method == "OPTIONS" && scope != "aws" {
		w.WriteHeader(204)
		return false
	}
	// Terminal endpoints spawn shells: Origin must be present AND allowlisted.
	if scope == "terminal" && (origin == "" || !ok) {
		return reject(w, "cross-origin terminal access not allowed")
	}
	// Cross-origin browser writes: reject. CLI/SDK callers send no Origin.
	if _, m := mutating[r.Method]; m && origin != "" && !ok {
		return reject(w, "cross-origin request not allowed")
	}
	// Defense in depth: Sec-Fetch-Site can't be forged by attacker JS.
	if _, m := mutating[r.Method]; m && r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return reject(w, "cross-site request not allowed")
	}
	return true
}

func reject(w http.ResponseWriter, message string) bool {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(403)
	fmt.Fprintf(w, `{"__type":"Forbidden","message":%q}`, message)
	return false
}
