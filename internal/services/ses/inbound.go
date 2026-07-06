// Inbound receipt rules (control-plane driven) + the /mockcloud/ses/* routes
// — port of the bottom half of src/services/ses.js and src/routes/ses.js.
//
// A local mock can't receive real SMTP, so inbound mail is simulated via the
// control plane (POST /mockcloud/ses/inbound). For each enabled receipt rule
// whose recipients match, run its actions — reusing the S3 / SNS / Lambda
// delivery paths so an inbound email can land an object, fan out a
// notification, or invoke a function, exactly like real SES receipt rules.
//
//	rule:   { name, enabled?, recipients: [addr|domain], actions: [Action] }
//	Action: { type:'s3', bucket, objectKeyPrefix? }
//	      | { type:'sns', topicArn }
//	      | { type:'lambda', functionArn }
package ses

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
)

// RegisterUIRoutes adds the /mockcloud/ses/* control-plane routes
// (src/routes/ses.js) via a callback, mirroring the Lambda/DynamoDB pattern.
func (svc *Service) RegisterUIRoutes(add func(method, pattern string, h func(http.ResponseWriter, *httpapi.Request))) {
	add("GET", "/mockcloud/ses/emails", func(w http.ResponseWriter, r *httpapi.Request) {
		limit := 100.0
		if v := r.Query.Get("limit"); v != "" { // Node: req.query?.limit || '100'
			limit = jsnum.ParseIntPrefix(v)
		}
		emails := []map[string]any{}
		var total float64
		svc.st.With(func(s *state.State) {
			emails = append(emails, s.SES.Emails[:sliceEnd(limit, len(s.SES.Emails))]...)
			total = s.SES.Sent
		})
		respond.JSON(w, 200, map[string]any{"emails": emails, "total": total})
	})

	// Create a receipt rule: { name, recipients?, actions:[{type,...}], enabled? }
	add("POST", "/mockcloud/ses/receipt-rules", func(w http.ResponseWriter, r *httpapi.Request) {
		body := r.ParsedBody
		name := httpapi.Str(body, "name")
		if name == "" {
			respond.ErrorJSON(w, 400, "ValidationError", "name required")
			return
		}
		recipients, ok := body["recipients"].([]any)
		if !ok {
			recipients = []any{}
		}
		actions, ok := body["actions"].([]any)
		if !ok {
			actions = []any{}
		}
		enabled := true // Node: enabled !== false
		if bv, isBool := body["enabled"].(bool); isBool && !bv {
			enabled = false
		}
		rule := map[string]any{
			"name": name, "recipients": recipients, "actions": actions,
			"enabled": enabled, "created": state.NowMs(),
		}
		svc.st.With(func(s *state.State) {
			kept := make([]map[string]any, 0, len(s.SES.ReceiptRules)+1)
			for _, existing := range s.SES.ReceiptRules {
				if existing["name"] != any(name) {
					kept = append(kept, existing)
				}
			}
			s.SES.ReceiptRules = append(kept, rule)
		})
		respond.JSON(w, 201, rule)
	})

	// Simulate an inbound email → runs matching receipt-rule actions.
	// Body: { from, to, subject, body }
	add("POST", "/mockcloud/ses/inbound", func(w http.ResponseWriter, r *httpapi.Request) {
		messageID, matched := svc.DeliverInboundEmail(r.ParsedBody)
		respond.JSON(w, 200, map[string]any{"messageId": messageID, "matched": matched, "id": state.RandomID(8)})
	})
}

// sliceEnd — JS Array.prototype.slice(0, limit) end-index semantics
// (NaN → 0, negative counts from the end, clamped to length).
func sliceEnd(limit float64, n int) int {
	switch {
	case math.IsNaN(limit):
		return 0
	case limit < 0:
		if end := n + int(limit); end > 0 {
			return end
		}
		return 0
	case limit >= float64(n):
		return n
	default:
		return int(limit)
	}
}

// DeliverInboundEmail runs matching receipt-rule actions for a simulated
// inbound email and records it in the same log the UI lists outbound from.
// Returns (messageId, matched rule names). Never called under the store lock.
func (svc *Service) DeliverInboundEmail(body map[string]any) (string, []string) {
	from := body["from"]
	toList, ok := body["to"].([]any)
	if !ok {
		toList = []any{body["to"]}
	}
	recipients := []any{} // .filter(Boolean)
	var recipientStrs []string
	for _, t := range toList {
		if jsnum.Truthy(t) {
			recipients = append(recipients, t)
			recipientStrs = append(recipientStrs, jsnum.ToString(t))
		}
	}
	messageID := state.RandomID(36)
	str := func(v any) string { // JS `${v || ''}`
		if jsnum.Truthy(v) {
			return jsnum.ToString(v)
		}
		return ""
	}
	subject, bodyText := body["subject"], body["body"]
	rawEmail := "From: " + str(from) + "\r\nTo: " + strings.Join(recipientStrs, ", ") +
		"\r\nSubject: " + str(subject) + "\r\n\r\n" + str(bodyText)

	matched := []string{}
	var actions []map[string]any
	svc.st.With(func(s *state.State) {
		for _, rule := range s.SES.ReceiptRules {
			if bv, isBool := rule["enabled"].(bool); isBool && !bv { // rule.enabled === false
				continue
			}
			rr, _ := rule["recipients"].([]any)
			if !recipientMatches(rr, recipientStrs) {
				continue
			}
			matched = append(matched, jsnum.ToString(rule["name"]))
			if acts, ok := rule["actions"].([]any); ok {
				for _, a := range acts {
					if am, ok := a.(map[string]any); ok {
						actions = append(actions, am)
					}
				}
			}
		}
	})

	ctx := receiptCtx{messageID: messageID, from: from, recipients: recipients, subject: subject, rawEmail: rawEmail}
	for _, action := range actions {
		if err := svc.runReceiptAction(action, ctx); err != nil {
			fmt.Fprintf(os.Stderr, "[SES] receipt action %v failed: %v\n", action["type"], err)
		}
	}

	email := map[string]any{
		"messageId": messageID, "direction": "inbound", "to": recipients,
		"subject": orDefault(subject, "(no subject)"), "body": orDefault(bodyText, ""),
		"matchedRules": matched, "sent": state.NowMs(),
	}
	setDefined(email, "from", from)
	svc.st.With(func(s *state.State) {
		s.SES.Emails = append([]map[string]any{email}, s.SES.Emails...)
		if len(s.SES.Emails) > 500 {
			s.SES.Emails = s.SES.Emails[:500]
		}
	})
	return messageID, matched
}

// recipientMatches — empty/absent recipient list on a rule matches
// everything. Otherwise match a full address, a domain (`example.com`), or an
// address ending in `@domain`.
func recipientMatches(ruleRecipients []any, recipients []string) bool {
	if len(ruleRecipients) == 0 {
		return true
	}
	for _, addr := range recipients {
		for _, raw := range ruleRecipients {
			r := jsnum.ToString(raw)
			if addr == r || strings.HasSuffix(addr, "@"+r) || strings.HasSuffix(addr, r) {
				return true
			}
		}
	}
	return false
}

type receiptCtx struct {
	messageID  string
	from       any
	recipients []any
	subject    any
	rawEmail   string
}

func (svc *Service) runReceiptAction(action map[string]any, ctx receiptCtx) error {
	typ := "" // Node: (action.type || '').toLowerCase()
	if jsnum.Truthy(action["type"]) {
		typ = jsnum.ToString(action["type"])
	}
	switch strings.ToLower(typ) {
	case "s3":
		key := httpapi.Str(action, "objectKeyPrefix") + ctx.messageID
		return svc.putObjectToBucket(httpapi.Str(action, "bucket"), key, []byte(ctx.rawEmail), "message/rfc822")

	case "sns":
		topicArn := httpapi.Str(action, "topicArn")
		var exists bool
		svc.st.With(func(s *state.State) {
			if t := s.SNS.Topics[topicArn]; t != nil {
				t.Published++
				exists = true
			}
		})
		if !exists {
			return nil
		}
		notification := string(respond.Marshal(map[string]any{
			"notificationType": "Received",
			"mail": map[string]any{
				"messageId": ctx.messageID, "source": ctx.from, "destination": ctx.recipients,
				"commonHeaders": map[string]any{"subject": ctx.subject},
			},
		}))
		if svc.FanoutSNS != nil {
			svc.FanoutSNS(topicArn, state.RandomID(36), notification, "Amazon SES Email Receipt Notification")
		}
		return nil

	case "lambda":
		functionArn := httpapi.Str(action, "functionArn")
		parts := strings.Split(functionArn, ":")
		fnName := parts[len(parts)-1]
		event := map[string]any{"Records": []any{map[string]any{
			"eventSource": "aws:ses", "eventVersion": "1.0",
			"ses": map[string]any{
				"mail": map[string]any{
					"messageId": ctx.messageID, "source": ctx.from, "destination": ctx.recipients,
					"commonHeaders": map[string]any{"subject": ctx.subject, "from": []any{ctx.from}, "to": ctx.recipients},
				},
				"receipt": map[string]any{
					"recipients": ctx.recipients,
					"action":     map[string]any{"type": "Lambda", "functionArn": functionArn},
				},
			},
		}}}
		if svc.InvokeLambda != nil {
			svc.InvokeLambda(fnName, string(respond.Marshal(event)))
		}
		return nil
	}
	return nil
}

// ── S3 write path (port of putObjectToBucket + writeObjectToDisk) ───────────
// Duplicated minimally from the s3 package (its disk helpers are unexported):
// '..' key segments become '__', the resolved path must stay inside S3_ROOT,
// and the write is tmp-file + rename with a plain-write fallback.

func md5hex(b []byte) string {
	sum := md5.Sum(b)
	return hex.EncodeToString(sum[:])
}

func (svc *Service) putObjectToBucket(bucketName, key string, buf []byte, contentType string) error {
	var exists bool
	svc.st.With(func(s *state.State) { exists = s.S3.Buckets[bucketName] != nil })
	if !exists {
		return fmt.Errorf("Bucket %s does not exist", bucketName)
	}
	if err := svc.writeObjectToDisk(bucketName, key, buf); err != nil {
		return err
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	meta := &state.ObjectMeta{
		Key: key, Size: int64(len(buf)), ContentType: contentType,
		ETag: md5hex(buf), Modified: state.NowMs(), Metadata: map[string]string{},
	}
	svc.st.With(func(s *state.State) {
		if b := s.S3.Buckets[bucketName]; b != nil {
			b.Objects[key] = meta
		}
	})
	return nil
}

func (svc *Service) writeObjectToDisk(bucket, key string, buf []byte) error {
	absRoot, err := filepath.Abs(svc.cfg.S3Root)
	if err != nil {
		return err
	}
	parts := strings.Split(key, "/")
	for i, p := range parts {
		if p == ".." {
			parts[i] = "__"
		}
	}
	target := filepath.Join(absRoot, bucket, filepath.FromSlash(strings.Join(parts, "/")))
	rel, err := filepath.Rel(absRoot, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return errors.New("path escape")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	tmp := target + ".tmp-" + state.RandomID(8)
	if err := os.WriteFile(tmp, buf, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		// fallback for cross-FS or weird Windows cases
		if werr := os.WriteFile(target, buf, 0o644); werr != nil {
			return werr
		}
		_ = os.Remove(tmp)
	}
	return nil
}
