// Package httpapi is the HTTP front door: request wrapper, CORS gate,
// panic boundary, and the top-level middleware chain — a port of
// src/index.js + src/middleware/http.js.
package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Request wraps *http.Request with the fields Node's attachBody provided:
// the fully drained body and, for JSON-family content types, the parsed
// document. Handlers MUST read from these — the body stream is at EOF.
type Request struct {
	*http.Request
	RawBody    []byte
	ParsedBody map[string]any
	Params     map[string]string // control-plane :params
	Query      url.Values
}

var jsonCTPrefixes = []string{
	"application/json",
	"application/x-amz-json-1.0",
	"application/x-amz-json-1.1",
}

// Attach drains the body once and conditionally JSON-parses it — the port of
// attachBody/parseBodyForJson (text/plain bodies are never silently parsed;
// that was the simple-CORS CSRF trick).
func Attach(r *http.Request) *Request {
	body, _ := io.ReadAll(r.Body)
	req := &Request{Request: r, RawBody: body, ParsedBody: map[string]any{}, Query: r.URL.Query()}
	ct := strings.ToLower(r.Header.Get("content-type"))
	for _, p := range jsonCTPrefixes {
		if strings.HasPrefix(ct, p) {
			src := body
			if len(src) == 0 {
				src = []byte("{}")
			}
			dec := json.NewDecoder(strings.NewReader(string(src)))
			dec.UseNumber() // float64 round-trips would corrupt large integers
			var parsed map[string]any
			if err := dec.Decode(&parsed); err == nil {
				req.ParsedBody = parsed
			}
			break
		}
	}
	return req
}

// JSONBody re-parses the raw body regardless of content type — the port of
// each service's own `JSON.parse(rawBody || '{}') catch {}` pattern.
func (r *Request) JSONBody() map[string]any {
	dec := json.NewDecoder(strings.NewReader(string(r.RawBody)))
	dec.UseNumber()
	var parsed map[string]any
	if err := dec.Decode(&parsed); err != nil || parsed == nil {
		return map[string]any{}
	}
	return parsed
}

// Str reads a string field from a parsed JSON body ("" when absent/not a
// string — matching JS's undefined-coerces-later patterns where the Node
// code did `payload.Field || fallback`).
func Str(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// Num reads a numeric field (json.Number or float64) as float64.
func Num(m map[string]any, key string) (float64, bool) {
	switch v := m[key].(type) {
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	case float64:
		return v, true
	}
	return 0, false
}
