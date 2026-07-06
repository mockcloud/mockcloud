// Package respond ports src/middleware/response.js — the shared response
// helpers whose byte shapes (error documents, headers) are part of the
// conformance surface.
package respond

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/mockcloud/mockcloud/internal/state"
)

func requestID() string { return state.RandomID(32) }

// Marshal is JSON.stringify-compatible: no HTML escaping (Go escapes <>& by
// default, Node does not), no trailing newline.
func Marshal(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return []byte("{}")
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("x-amzn-RequestId", requestID())
	w.WriteHeader(status)
	_, _ = w.Write(Marshal(v))
}

func XML(w http.ResponseWriter, status int, xmlStr string) {
	w.Header().Set("Content-Type", "application/xml")
	w.Header().Set("x-amzn-RequestId", requestID())
	w.WriteHeader(status)
	_, _ = w.Write([]byte(xmlStr))
}

func ErrorJSON(w http.ResponseWriter, status int, code, message string) {
	JSON(w, status, map[string]string{"__type": code, "message": message})
}

func ErrorXML(w http.ResponseWriter, status int, code, message string) {
	XML(w, status,
		`<?xml version="1.0"?><ErrorResponse><Error><Code>`+code+`</Code><Message>`+
			EscapeXML(message)+`</Message></Error></ErrorResponse>`)
}

// EscapeXML matches Node's escapeXml — exactly these four entities, in this
// order.
func EscapeXML(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	return s
}

// SendInternalError is the last-resort error boundary (sendInternalError):
// JSON __type shape for JSON-protocol requests, an S3 <Error> document
// otherwise. Body strings are byte-exact conformance surface.
func SendInternalError(w http.ResponseWriter, r *http.Request, headersSent bool) {
	if headersSent {
		return
	}
	isJSON := r.Header.Get("x-amz-target") != "" ||
		strings.Contains(strings.ToLower(r.Header.Get("content-type")), "json")
	if isJSON {
		w.Header().Set("Content-Type", "application/x-amz-json-1.0")
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"__type":"InternalFailure","message":"The request processing has failed because of an unknown error."}`))
	} else {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>`))
	}
}
