// /mockcloud/terminal/* — the strict terminal feature gate from
// src/routes/terminal.js. The terminal runs real shell commands on the HOST,
// so it is an unauthenticated remote-shell sink if left open: DISABLED by
// default, opted into explicitly, and only over loopback unless forced.
//
//	MOCKCLOUD_ENABLE_TERMINAL=true|1   enable (loopback binds only)
//	MOCKCLOUD_ENABLE_TERMINAL=force    enable even on a non-loopback bind
package controlplane

import (
	"net/http"
	"strings"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/services/terminal"
)

const terminalDisabledMsg = "Terminal is disabled. It executes host shell commands, so it is off by default — " +
	"set MOCKCLOUD_ENABLE_TERMINAL=true (loopback binds only; use =force to allow a non-loopback bind)."

func RegisterTerminalRoutes(rt *Router, d Deps) {
	mgr := terminal.NewManager()
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

	rt.Post("/mockcloud/terminal/sessions", func(w http.ResponseWriter, r *httpapi.Request) {
		if denied(w) {
			return
		}
		sessionType, _ := r.ParsedBody["type"].(string)
		if !jsnum.Truthy(r.ParsedBody["type"]) {
			respond.ErrorJSON(w, 400, "ValidationError", "type required")
			return
		}
		id, err := mgr.CreateSession(sessionType)
		if err != nil {
			respond.ErrorJSON(w, 400, "TerminalError", err.Error())
			return
		}
		respond.JSON(w, 201, map[string]any{"sessionId": id})
	})

	rt.Get("/mockcloud/terminal/sessions/:id/stream", func(w http.ResponseWriter, r *httpapi.Request) {
		if denied(w) {
			return
		}
		session := mgr.Get(r.Params["id"])
		if session == nil {
			respond.ErrorJSON(w, 404, "NotFound", "Session not found")
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			respond.ErrorJSON(w, 500, "InternalError", "streaming unsupported")
			return
		}
		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
		h.Set("X-Accel-Buffering", "no")
		w.WriteHeader(200)

		events := make(chan terminal.Chunk, 256)
		backlog, unsubscribe := session.Subscribe(func(c terminal.Chunk) {
			select {
			case events <- c:
			default: // drop if the client can't keep up (bounded like Node's buffer)
			}
		})
		defer unsubscribe()
		send := func(c terminal.Chunk) {
			_, _ = w.Write([]byte("data: " + string(respond.Marshal(c)) + "\n\n"))
			flusher.Flush()
		}
		for _, c := range backlog {
			send(c)
		}
		if session.Closed() {
			return
		}
		ctx := r.Context()
		for {
			select {
			case <-ctx.Done():
				return
			case c := <-events:
				send(c)
			}
		}
	})

	rt.Post("/mockcloud/terminal/sessions/:id/exec", func(w http.ResponseWriter, r *httpapi.Request) {
		if denied(w) {
			return
		}
		command, _ := r.ParsedBody["command"].(string)
		if !jsnum.Truthy(r.ParsedBody["command"]) {
			respond.ErrorJSON(w, 400, "ValidationError", "command required")
			return
		}
		if err := mgr.ExecCommand(r.Params["id"], command); err != nil {
			respond.ErrorJSON(w, 400, "Error", err.Error())
			return
		}
		respond.JSON(w, 200, map[string]any{"ok": true})
	})

	rt.Post("/mockcloud/terminal/sessions/:id/interrupt", func(w http.ResponseWriter, r *httpapi.Request) {
		if denied(w) {
			return
		}
		mgr.Interrupt(r.Params["id"])
		respond.JSON(w, 200, map[string]any{"ok": true})
	})

	rt.Delete("/mockcloud/terminal/sessions/:id", func(w http.ResponseWriter, r *httpapi.Request) {
		if denied(w) {
			return
		}
		mgr.CloseSession(r.Params["id"])
		respond.JSON(w, 200, map[string]any{"closed": true})
	})
}
