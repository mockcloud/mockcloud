// Package bedrock — port of src/services/bedrock.js. Path-routed REST-JSON
// (POST /model/<id>/{invoke,invoke-with-response-stream,converse,
// converse-stream}, /guardrail/*). Responses are canned and configurable via
// store.bedrock + the /mockcloud/bedrock control plane; streaming uses the
// vnd.amazon.eventstream binary framing.
package bedrock

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

type Service struct{ st *store.Store }

func New(st *store.Store) *Service { return &Service{st: st} }

var pathRe = regexp.MustCompile(`^/model/(.+)/(invoke-with-response-stream|invoke|converse-stream|converse)$`)

func (svc *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	path := r.URL.EscapedPath()
	if strings.HasPrefix(path, "/guardrail/") {
		svc.applyGuardrail(w, r)
		return
	}
	m := pathRe.FindStringSubmatch(path)
	if m == nil {
		respond.JSON(w, 404, map[string]any{"__type": "ResourceNotFoundException", "message": "Unknown Bedrock path: " + path})
		return
	}
	modelID, err := url.PathUnescape(m[1])
	if err != nil {
		modelID = m[1]
	}
	op := m[2]
	body := r.JSONBody()
	prompt := extractPrompt(body)

	respText, fault := svc.resolveRule(modelID, prompt)
	svc.recordInvocation(modelID, op, prompt, fault)

	if fault != nil {
		status := intOr(fault["statusCode"], 400)
		respond.JSON(w, status, map[string]any{
			"__type":  strOr(fault["type"], "ThrottlingException"),
			"message": strOr(fault["message"], "Mock Bedrock fault"),
		})
		return
	}

	inputTokens := approxTokens(prompt)
	outputTokens := approxTokens(respText)

	switch op {
	case "invoke":
		svc.invokeModel(w, modelID, respText, inputTokens, outputTokens)
	case "converse":
		svc.converse(w, respText, inputTokens, outputTokens)
	case "invoke-with-response-stream":
		svc.invokeModelStream(w, respText, inputTokens, outputTokens)
	case "converse-stream":
		svc.converseStream(w, respText, inputTokens, outputTokens)
	}
}

// ── Non-streaming ───────────────────────────────────────────────────────────

func (svc *Service) invokeModel(w http.ResponseWriter, modelID, text string, inputTokens, outputTokens int) {
	var body map[string]any
	switch {
	case strings.HasPrefix(modelID, "anthropic."):
		body = map[string]any{
			"id": "msg_" + state.RandomID(24), "type": "message", "role": "assistant", "model": modelID,
			"content":     []any{map[string]any{"type": "text", "text": text}},
			"stop_reason": "end_turn", "stop_sequence": nil,
			"usage": map[string]any{"input_tokens": inputTokens, "output_tokens": outputTokens},
		}
	case strings.HasPrefix(modelID, "amazon.titan"):
		body = map[string]any{
			"inputTextTokenCount": inputTokens,
			"results":             []any{map[string]any{"tokenCount": outputTokens, "outputText": text, "completionReason": "FINISH"}},
		}
	default:
		body = map[string]any{"outputText": text, "completionReason": "FINISH"}
	}
	respond.JSON(w, 200, body)
}

func (svc *Service) converse(w http.ResponseWriter, text string, inputTokens, outputTokens int) {
	respond.JSON(w, 200, map[string]any{
		"output":     map[string]any{"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"text": text}}}},
		"stopReason": "end_turn",
		"usage":      map[string]any{"inputTokens": inputTokens, "outputTokens": outputTokens, "totalTokens": inputTokens + outputTokens},
		"metrics":    map[string]any{"latencyMs": 5},
	})
}

// ── Streaming (vnd.amazon.eventstream) ───────────────────────────────────────

func startStream(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/vnd.amazon.eventstream")
	w.Header().Set("x-amzn-RequestId", state.RandomID(32))
	w.WriteHeader(200)
}

func flush(w http.ResponseWriter) {
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

func (svc *Service) invokeModelStream(w http.ResponseWriter, text string, inputTokens, outputTokens int) {
	startStream(w)
	chunk := func(obj map[string]any) {
		payload := map[string]any{"bytes": base64.StdEncoding.EncodeToString(respond.Marshal(obj))}
		_, _ = w.Write(eventFrame("chunk", payload))
		flush(w)
	}
	chunk(map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant", "usage": map[string]any{"input_tokens": inputTokens, "output_tokens": 0}}})
	chunk(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
	for _, piece := range splitForStream(text) {
		chunk(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": piece}})
	}
	chunk(map[string]any{"type": "content_block_stop", "index": 0})
	chunk(map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}, "usage": map[string]any{"output_tokens": outputTokens}})
	chunk(map[string]any{"type": "message_stop"})
}

func (svc *Service) converseStream(w http.ResponseWriter, text string, inputTokens, outputTokens int) {
	startStream(w)
	write := func(eventType string, payload map[string]any) {
		_, _ = w.Write(eventFrame(eventType, payload))
		flush(w)
	}
	write("messageStart", map[string]any{"role": "assistant"})
	for _, piece := range splitForStream(text) {
		write("contentBlockDelta", map[string]any{"contentBlockIndex": 0, "delta": map[string]any{"text": piece}})
	}
	write("contentBlockStop", map[string]any{"contentBlockIndex": 0})
	write("messageStop", map[string]any{"stopReason": "end_turn"})
	write("metadata", map[string]any{
		"usage":   map[string]any{"inputTokens": inputTokens, "outputTokens": outputTokens, "totalTokens": inputTokens + outputTokens},
		"metrics": map[string]any{"latencyMs": 5},
	})
}

func (svc *Service) applyGuardrail(w http.ResponseWriter, r *httpapi.Request) {
	body := r.JSONBody()
	outputs := []any{}
	if content, ok := body["content"].([]any); ok {
		for _, c := range content {
			cm, _ := c.(map[string]any)
			text := ""
			if inner, ok := cm["text"].(map[string]any); ok {
				text, _ = inner["text"].(string)
			}
			outputs = append(outputs, map[string]any{"text": text})
		}
	}
	respond.JSON(w, 200, map[string]any{"usage": map[string]any{}, "action": "NONE", "outputs": outputs, "assessments": []any{}})
}

// ── Rule resolution / config ─────────────────────────────────────────────────

func (svc *Service) resolveRule(modelID, prompt string) (string, map[string]any) {
	var text string
	var fault map[string]any
	svc.st.With(func(s *state.State) {
		def := s.Bedrock.DefaultResponse
		for _, rule := range s.Bedrock.Rules {
			if model, ok := rule["model"].(string); ok && model != "" && !globMatch(model, modelID) {
				continue
			}
			if pc, ok := rule["promptContains"].(string); ok && pc != "" && !strings.Contains(prompt, pc) {
				continue
			}
			text = def
			if r, ok := rule["response"].(string); ok {
				text = r
			}
			if f, ok := rule["fault"].(map[string]any); ok {
				fault = f
			}
			return
		}
		text = def
	})
	return text, fault
}

func (svc *Service) recordInvocation(modelID, op, prompt string, fault map[string]any) {
	svc.st.With(func(s *state.State) {
		if len(prompt) > 500 {
			prompt = prompt[:500]
		}
		inv := map[string]any{
			"id": state.RandomID(16), "t": state.NowMs(), "modelId": modelID, "op": op,
			"prompt": prompt, "faulted": fault != nil,
		}
		s.Bedrock.Invocations = append([]map[string]any{inv}, s.Bedrock.Invocations...)
		if len(s.Bedrock.Invocations) > 200 {
			s.Bedrock.Invocations = s.Bedrock.Invocations[:200]
		}
		status := 200
		if fault != nil {
			status = intOr(fault["statusCode"], 400)
		}
		s.AddTrail(map[string]any{"method": "POST", "path": "/bedrock/" + op + "/" + modelID, "status": status, "latency": 5})
	})
}

// RegisterUIRoutes — the /mockcloud/bedrock control plane (src/routes/bedrock.js).
func (svc *Service) RegisterUIRoutes(add func(method, pattern string, h func(http.ResponseWriter, *httpapi.Request))) {
	add("GET", "/mockcloud/bedrock", func(w http.ResponseWriter, r *httpapi.Request) {
		var out map[string]any
		svc.st.With(func(s *state.State) {
			invs := s.Bedrock.Invocations
			if len(invs) > 50 {
				invs = invs[:50]
			}
			out = map[string]any{"defaultResponse": s.Bedrock.DefaultResponse, "rules": s.Bedrock.Rules, "invocations": invs}
		})
		respond.JSON(w, 200, out)
	})
	add("PUT", "/mockcloud/bedrock", func(w http.ResponseWriter, r *httpapi.Request) {
		b := r.ParsedBody
		var def string
		svc.st.With(func(s *state.State) {
			if v, ok := b["defaultResponse"].(string); ok {
				s.Bedrock.DefaultResponse = v
			}
			def = s.Bedrock.DefaultResponse
		})
		respond.JSON(w, 200, map[string]any{"defaultResponse": def})
	})
	add("POST", "/mockcloud/bedrock/rules", func(w http.ResponseWriter, r *httpapi.Request) {
		b := r.ParsedBody
		rule := map[string]any{
			"id":             state.RandomID(8),
			"model":          orNil(b["model"]),
			"promptContains": orNil(b["promptContains"]),
			"fault":          orNil(b["fault"]),
		}
		if resp, ok := b["response"].(string); ok {
			rule["response"] = resp
		}
		svc.st.With(func(s *state.State) { s.Bedrock.Rules = append(s.Bedrock.Rules, rule) })
		respond.JSON(w, 201, rule)
	})
	add("DELETE", "/mockcloud/bedrock/rules", func(w http.ResponseWriter, r *httpapi.Request) {
		svc.st.With(func(s *state.State) { s.Bedrock.Rules = []map[string]any{} })
		respond.JSON(w, 200, map[string]any{"cleared": true})
	})
	add("DELETE", "/mockcloud/bedrock", func(w http.ResponseWriter, r *httpapi.Request) {
		svc.st.With(func(s *state.State) { s.Reset("bedrock") })
		respond.JSON(w, 200, map[string]any{"reset": true})
	})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func extractPrompt(body map[string]any) string {
	if body == nil {
		return ""
	}
	if msgs, ok := body["messages"].([]any); ok && len(msgs) > 0 {
		last, _ := msgs[len(msgs)-1].(map[string]any)
		if last != nil {
			return contentToText(last["content"])
		}
	}
	if v, ok := body["inputText"].(string); ok {
		return v
	}
	if v, ok := body["prompt"].(string); ok {
		return v
	}
	return ""
}

func contentToText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var parts []string
		for _, item := range c {
			if s, ok := item.(string); ok {
				parts = append(parts, s)
			} else if m, ok := item.(map[string]any); ok {
				if t, ok := m["text"].(string); ok {
					parts = append(parts, t)
				} else {
					parts = append(parts, "")
				}
			}
		}
		return strings.TrimSpace(strings.Join(parts, " "))
	}
	return ""
}

func approxTokens(s string) int {
	n := (len(s) + 3) / 4
	if n < 1 {
		return 1
	}
	return n
}

// splitForStream — split by whitespace runs, keeping separators (JS
// split(/(\s+)/).filter(Boolean)); empty text → [text].
var wsSplitRe = regexp.MustCompile(`(\s+)`)

func splitForStream(text string) []string {
	if text == "" {
		return []string{""}
	}
	var out []string
	last := 0
	for _, loc := range wsSplitRe.FindAllStringIndex(text, -1) {
		if loc[0] > last {
			out = append(out, text[last:loc[0]]) // word
		}
		out = append(out, text[loc[0]:loc[1]]) // separator
		last = loc[1]
	}
	if last < len(text) {
		out = append(out, text[last:])
	}
	if len(out) == 0 {
		return []string{text}
	}
	return out
}

func globMatch(pattern, value string) bool {
	if pattern == value {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return false
	}
	parts := strings.Split(pattern, "*")
	for i, p := range parts {
		parts[i] = regexp.QuoteMeta(p)
	}
	re, err := regexp.Compile("^" + strings.Join(parts, ".*") + "$")
	return err == nil && re.MatchString(value)
}

func intOr(v any, def int) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return int(i)
		}
	}
	return def
}

func strOr(v any, def string) string {
	if s, ok := v.(string); ok {
		return s
	}
	return def
}

func orNil(v any) any {
	if v == nil {
		return nil
	}
	// Node's `|| null`: empty string is falsy → null.
	if s, ok := v.(string); ok && s == "" {
		return nil
	}
	return v
}

// ── vnd.amazon.eventstream framing ───────────────────────────────────────────
// Frame: [totalLen u32][headerLen u32][preludeCRC u32][headers][payload][msgCRC u32]
// Header: [nameLen u8][name][valueType u8=7][valueLen u16][value]

func eventFrame(eventType string, payloadObj map[string]any) []byte {
	headers := []hdr{
		{":message-type", "event"},
		{":event-type", eventType},
		{":content-type", "application/json"},
	}
	return encodeMessage(headers, respond.Marshal(payloadObj))
}

type hdr struct{ name, value string }

func encodeMessage(headers []hdr, payload []byte) []byte {
	var headerBuf []byte
	for _, h := range headers {
		headerBuf = append(headerBuf, encodeHeader(h.name, h.value)...)
	}
	totalLen := 4 + 4 + 4 + len(headerBuf) + len(payload) + 4
	msg := make([]byte, totalLen)
	o := 0
	binary.BigEndian.PutUint32(msg[o:], uint32(totalLen))
	o += 4
	binary.BigEndian.PutUint32(msg[o:], uint32(len(headerBuf)))
	o += 4
	binary.BigEndian.PutUint32(msg[o:], crc32.ChecksumIEEE(msg[0:8])) // prelude CRC
	o += 4
	copy(msg[o:], headerBuf)
	o += len(headerBuf)
	copy(msg[o:], payload)
	o += len(payload)
	binary.BigEndian.PutUint32(msg[o:], crc32.ChecksumIEEE(msg[0:o])) // message CRC
	return msg
}

func encodeHeader(name, value string) []byte {
	nameB := []byte(name)
	valB := []byte(value)
	buf := make([]byte, 1+len(nameB)+1+2+len(valB))
	o := 0
	buf[o] = byte(len(nameB))
	o++
	copy(buf[o:], nameB)
	o += len(nameB)
	buf[o] = 7 // value type 7 = UTF-8 string
	o++
	binary.BigEndian.PutUint16(buf[o:], uint16(len(valB)))
	o += 2
	copy(buf[o:], valB)
	return buf
}
