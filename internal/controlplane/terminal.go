// /mockcloud/terminal/* — the strict terminal feature gate from
// src/routes/terminal.js. The terminal runs real shell commands on the HOST,
// so it is an unauthenticated remote-shell sink if left open: DISABLED by
// default, opted into explicitly, and only over loopback unless forced.
//
//	MOCKCLOUD_ENABLE_TERMINAL=true|1   enable (loopback binds only)
//	MOCKCLOUD_ENABLE_TERMINAL=force    enable even on a non-loopback bind
//
// The session machinery itself (SSE streaming, shell spawning) is M10 scope;
// until then the enabled path answers a TerminalError so the gate semantics
// (403 when disabled — asserted by tests/security.test.js) are exact.
package controlplane

import (
	"net/http"
	"strings"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
)

const terminalDisabledMsg = "Terminal is disabled. It executes host shell commands, so it is off by default — " +
	"set MOCKCLOUD_ENABLE_TERMINAL=true (loopback binds only; use =force to allow a non-loopback bind)."

func RegisterTerminalRoutes(rt *Router, d Deps) {
	terminalEnabled := func() bool {
		v := strings.ToLower(d.Cfg.EnableTerminal)
		if v != "true" && v != "1" && v != "force" {
			return false
		}
		if v == "force" {
			return true
		}
		host := d.Cfg.Host
		return host == "127.0.0.1" || host == "localhost" || host == "::1"
	}
	denied := func(w http.ResponseWriter) bool {
		if terminalEnabled() {
			return false
		}
		respond.ErrorJSON(w, 403, "AccessDeniedException", terminalDisabledMsg)
		return true
	}
	notPorted := func(w http.ResponseWriter) {
		respond.ErrorJSON(w, 400, "TerminalError", "MockCloud Go port: terminal not yet ported (M10)")
	}

	rt.Post("/mockcloud/terminal/sessions", func(w http.ResponseWriter, r *httpapi.Request) {
		if denied(w) {
			return
		}
		if !jsnum.Truthy(r.ParsedBody["type"]) {
			respond.ErrorJSON(w, 400, "ValidationError", "type required")
			return
		}
		notPorted(w)
	})

	rt.Get("/mockcloud/terminal/sessions/:id/stream", func(w http.ResponseWriter, r *httpapi.Request) {
		if denied(w) {
			return
		}
		// No sessions can exist before M10 lands the terminal service.
		respond.ErrorJSON(w, 404, "NotFound", "Session not found")
	})

	rt.Post("/mockcloud/terminal/sessions/:id/exec", func(w http.ResponseWriter, r *httpapi.Request) {
		if denied(w) {
			return
		}
		if !jsnum.Truthy(r.ParsedBody["command"]) {
			respond.ErrorJSON(w, 400, "ValidationError", "command required")
			return
		}
		notPorted(w)
	})

	rt.Post("/mockcloud/terminal/sessions/:id/interrupt", func(w http.ResponseWriter, r *httpapi.Request) {
		if denied(w) {
			return
		}
		notPorted(w)
	})

	rt.Delete("/mockcloud/terminal/sessions/:id", func(w http.ResponseWriter, r *httpapi.Request) {
		if denied(w) {
			return
		}
		notPorted(w)
	})
}
