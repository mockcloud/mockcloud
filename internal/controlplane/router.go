// Package controlplane implements the /mockcloud/* internal REST API — the
// router (a port of src/router.js) and the route modules the console UI and
// the conformance harness depend on.
package controlplane

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/mockcloud/mockcloud/internal/httpapi"
)

type Handler func(w http.ResponseWriter, r *httpapi.Request)

type route struct {
	method  string
	re      *regexp.Regexp
	keys    []string
	handler Handler
}

type Router struct {
	routes []route
}

var paramRe = regexp.MustCompile(`:([^/]+)`)

func (rt *Router) Add(method, pattern string, h Handler) {
	var keys []string
	rePat := paramRe.ReplaceAllStringFunc(regexp.QuoteMeta(pattern), func(m string) string {
		// QuoteMeta leaves ':name' untouched (no metacharacters), so m is the
		// original ':key' text.
		keys = append(keys, m[1:])
		return `([^/]+)`
	})
	re := regexp.MustCompile(`^` + rePat + `(?:\?.*)?$`)
	rt.routes = append(rt.routes, route{method: strings.ToUpper(method), re: re, keys: keys, handler: h})
}

func (rt *Router) Get(p string, h Handler)    { rt.Add("GET", p, h) }
func (rt *Router) Post(p string, h Handler)   { rt.Add("POST", p, h) }
func (rt *Router) Put(p string, h Handler)    { rt.Add("PUT", p, h) }
func (rt *Router) Delete(p string, h Handler) { rt.Add("DELETE", p, h) }

// Dispatch returns true when a route matched (whether or not the handler
// succeeded), false when the request should fall through to AWS dispatch.
// Malformed %-escapes in path params → 400 BadRequest; handler panics → 500
// {error} — both port the Node router's catch behavior.
func (rt *Router) Dispatch(w http.ResponseWriter, r *httpapi.Request) bool {
	// Node matched url.pathname from WHATWG URL — percent-escapes preserved.
	path := r.URL.EscapedPath()
	for _, ro := range rt.routes {
		if ro.method != "" && ro.method != r.Method {
			continue
		}
		m := ro.re.FindStringSubmatch(path)
		if m == nil {
			continue
		}
		r.Params = map[string]string{}
		badEscape := false
		for i, k := range ro.keys {
			dec, err := url.PathUnescape(m[i+1])
			if err != nil {
				badEscape = true
				break
			}
			r.Params[k] = dec
		}
		if badEscape {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"__type":"BadRequest","message":"malformed URL parameter"}`))
			return true
		}
		func() {
			defer func() {
				if e := recover(); e != nil {
					fmt.Printf("[Router] Handler error: %v\n", e)
					// Best-effort 500 — if headers are already out this write
					// fails silently, matching res.headersSent bail.
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(500)
					fmt.Fprintf(w, `{"error":%q}`, fmt.Sprint(e))
				}
			}()
			ro.handler(w, r)
		}()
		return true
	}
	return false
}
