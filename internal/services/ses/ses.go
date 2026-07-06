// Package ses — port of src/services/ses.js: outbound SendEmail/SendRawEmail
// over both the JSON-target and query/XML protocols (SES answers XML on the
// form path — the response strings below are byte-for-byte Node's), identity
// verification, quotas/statistics, and control-plane-driven inbound receipt
// rules (inbound.go) that fan out to S3 / SNS / Lambda.
package ses

import (
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/mockcloud/mockcloud/internal/config"
	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

type Service struct {
	st  *store.Store
	cfg *config.Config
	// Seams wired by dispatch.New — both called OUTSIDE the store lock.
	// FanoutSNS is synchronous (Node awaited fanoutSnsMessage for receipt
	// actions); InvokeLambda is fire-and-forget (source 'ses').
	FanoutSNS    func(topicArn, msgID, message, subject string)
	InvokeLambda func(fnName, eventJSON string)
}

func New(st *store.Store, cfg *config.Config) *Service { return &Service{st: st, cfg: cfg} }

func (svc *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	target := r.Header.Get("x-amz-target")
	if op, ok := strings.CutPrefix(target, "AmazonSimpleEmailService."); ok {
		b := r.JSONBody()
		switch op {
		case "SendEmail":
			svc.sendEmailJSON(w, b)
			return
		case "SendRawEmail":
			svc.sendRawEmailJSON(w, b)
			return
		case "VerifyEmailIdentity", "VerifyEmailAddress":
			svc.verifyEmailJSON(w, b)
			return
		case "ListIdentities", "ListVerifiedEmailAddresses":
			svc.listIdentitiesJSON(w)
			return
		case "DeleteIdentity":
			svc.deleteIdentityJSON(w, b)
			return
		case "GetSendQuota":
			svc.getSendQuotaJSON(w)
			return
		case "GetSendStatistics":
			respond.JSON(w, 200, map[string]any{"SendDataPoints": []any{}})
			return
		case "GetIdentityVerificationAttributes":
			svc.getVerificationAttrsJSON(w, b)
			return
		}
	}

	// Form-encoded (old SES style)
	params, _ := url.ParseQuery(string(r.RawBody))
	action := params.Get("Action")
	if action == "" {
		action = r.Query.Get("Action")
	}
	switch action {
	case "SendEmail":
		svc.sendEmailForm(w, params)
		return
	case "SendRawEmail":
		svc.sendRawEmailForm(w, params)
		return
	case "VerifyEmailIdentity", "VerifyEmailAddress":
		svc.verifyEmailForm(w, params, action)
		return
	case "ListIdentities":
		svc.listIdentitiesForm(w, "ListIdentities", "Identities")
		return
	case "ListVerifiedEmailAddresses":
		svc.listIdentitiesForm(w, "ListVerifiedEmailAddresses", "VerifiedEmailAddresses")
		return
	case "DeleteIdentity":
		svc.deleteIdentityForm(w, params)
		return
	case "GetSendQuota":
		svc.getSendQuotaForm(w)
		return
	case "GetSendStatistics":
		respond.XML(w, 200, `<?xml version="1.0"?><GetSendStatisticsResponse><GetSendStatisticsResult><SendDataPoints/></GetSendStatisticsResult></GetSendStatisticsResponse>`)
		return
	case "GetIdentityVerificationAttributes":
		svc.getVerificationAttrsForm(w, params)
		return
	}

	// Query-protocol callers expect an XML <ErrorResponse>; JSON targets a
	// {__type}. (Node: `${target || action}` — both empty renders "null".)
	if action != "" && target == "" {
		respond.ErrorXML(w, 400, "InvalidAction", "Unknown SES action: "+action)
		return
	}
	label := target
	if label == "" {
		label = action
	}
	if label == "" {
		label = "null"
	}
	respond.ErrorJSON(w, 400, "InvalidAction", "Unknown SES action: "+label)
}

// mkEmail records an outbound email (ring capped at 500) and bumps the sent
// counter. `to` non-arrays are wrapped, like Node's mkEmail.
func (svc *Service) mkEmail(from, to, subject, body, html any) string {
	id := state.RandomID(36)
	toArr, ok := to.([]any)
	if !ok {
		toArr = []any{to}
	}
	email := map[string]any{
		"messageId": id,
		"subject":   orDefault(subject, "(no subject)"),
		"body":      orDefault(body, ""),
		"html":      orDefault(html, ""),
		"sent":      state.NowMs(),
	}
	email["to"] = toArr
	setDefined(email, "from", from)
	svc.st.With(func(s *state.State) {
		s.SES.Emails = append([]map[string]any{email}, s.SES.Emails...)
		if len(s.SES.Emails) > 500 {
			s.SES.Emails = s.SES.Emails[:500]
		}
		s.SES.Sent++
		s.AddTrail(map[string]any{"method": "POST", "path": "/ses/SendEmail", "status": 200, "latency": 8})
	})
	return id
}

// orDefault — JS `v || def`.
func orDefault(v, def any) any {
	if jsnum.Truthy(v) {
		return v
	}
	return def
}

// setDefined mirrors JSON.stringify dropping undefined-valued keys.
func setDefined(m map[string]any, key string, v any) {
	if v != nil {
		m[key] = v
	}
}

// dig — optional chaining over the any-tree (a?.b?.c).
func dig(m map[string]any, keys ...string) any {
	var cur any = m
	for _, k := range keys {
		mm, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = mm[k]
	}
	return cur
}

// ── JSON-target handlers ────────────────────────────────────────────────────

func (svc *Service) sendEmailJSON(w http.ResponseWriter, b map[string]any) {
	from := orDefault(orDefault(b["Source"], b["FromEmailAddress"]), "noreply@mockcloud.local")
	to := orDefault(orDefault(dig(b, "Destination", "ToAddresses"), dig(b, "Destination", "to")), []any{})
	subject := orDefault(orDefault(dig(b, "Message", "Subject", "Data"), b["Subject"]), "")
	body := orDefault(dig(b, "Message", "Body", "Text", "Data"), "")
	html := orDefault(dig(b, "Message", "Body", "Html", "Data"), "")
	id := svc.mkEmail(from, to, subject, body, html)
	respond.JSON(w, 200, map[string]any{"MessageId": id})
}

func (svc *Service) sendRawEmailJSON(w http.ResponseWriter, b map[string]any) {
	id := svc.mkEmail("raw@mockcloud.local", []any{}, "(raw email)", orDefault(dig(b, "RawMessage", "Data"), ""), "")
	respond.JSON(w, 200, map[string]any{"MessageId": id})
}

func (svc *Service) verifyEmailJSON(w http.ResponseWriter, b map[string]any) {
	email := orDefault(b["EmailAddress"], b["Identity"])
	if jsnum.Truthy(email) {
		svc.st.With(func(s *state.State) {
			s.SES.Identities[jsnum.ToString(email)] = map[string]any{"email": email, "status": "Success", "verified": true}
		})
	}
	respond.JSON(w, 200, map[string]any{})
}

func (svc *Service) deleteIdentityJSON(w http.ResponseWriter, b map[string]any) {
	svc.st.With(func(s *state.State) { delete(s.SES.Identities, httpapi.Str(b, "Identity")) })
	respond.JSON(w, 200, map[string]any{})
}

func (svc *Service) listIdentitiesJSON(w http.ResponseWriter) {
	ids := []string{}
	svc.st.With(func(s *state.State) {
		for k := range s.SES.Identities {
			ids = append(ids, k)
		}
	})
	sort.Strings(ids)
	respond.JSON(w, 200, map[string]any{"Identities": ids})
}

func (svc *Service) getSendQuotaJSON(w http.ResponseWriter) {
	var sent float64
	svc.st.With(func(s *state.State) { sent = s.SES.Sent })
	respond.JSON(w, 200, map[string]any{"Max24HourSend": 50000, "MaxSendRate": 14, "SentLast24Hours": sent})
}

func (svc *Service) getVerificationAttrsJSON(w http.ResponseWriter, b map[string]any) {
	attrs := map[string]any{}
	ids, _ := b["Identities"].([]any)
	svc.st.With(func(s *state.State) {
		for _, raw := range ids {
			id := jsnum.ToString(raw)
			status := "Pending"
			if _, ok := s.SES.Identities[id]; ok {
				status = "Success"
			}
			attrs[id] = map[string]any{"VerificationStatus": status}
		}
	})
	respond.JSON(w, 200, map[string]any{"VerificationAttributes": attrs})
}

// ── Form-encoded variants (XML responses — byte-for-byte Node's strings) ────

// formVal — a form field as an any-tree value: present → string, absent →
// nil (Node's undefined, so mkEmail's `|| fallback`s behave identically).
func formVal(params url.Values, key string) any {
	if params.Has(key) {
		return params.Get(key)
	}
	return nil
}

func (svc *Service) sendEmailForm(w http.ResponseWriter, p url.Values) {
	id := svc.mkEmail(formVal(p, "Source"), formVal(p, "Destination.ToAddresses.member.1"),
		formVal(p, "Message.Subject.Data"), formVal(p, "Message.Body.Text.Data"), formVal(p, "Message.Body.Html.Data"))
	respond.XML(w, 200, `<?xml version="1.0"?><SendEmailResponse><SendEmailResult><MessageId>`+id+`</MessageId></SendEmailResult></SendEmailResponse>`)
}

func (svc *Service) sendRawEmailForm(w http.ResponseWriter, p url.Values) {
	id := svc.mkEmail("raw@mockcloud.local", []any{}, "(raw email)", orDefault(formVal(p, "RawMessage.Data"), ""), "")
	respond.XML(w, 200, `<?xml version="1.0"?><SendRawEmailResponse><SendRawEmailResult><MessageId>`+id+`</MessageId></SendRawEmailResult></SendRawEmailResponse>`)
}

// VerifyEmailIdentity and the legacy VerifyEmailAddress differ only in the
// response wrapper, so both route here with their action name.
func (svc *Service) verifyEmailForm(w http.ResponseWriter, p url.Values, name string) {
	if email := p.Get("EmailAddress"); email != "" {
		svc.st.With(func(s *state.State) {
			s.SES.Identities[email] = map[string]any{"email": email, "status": "Success", "verified": true}
		})
	}
	respond.XML(w, 200, `<?xml version="1.0"?><`+name+`Response><`+name+`Result/></`+name+`Response>`)
}

// Same for ListIdentities / ListVerifiedEmailAddresses (different list element).
func (svc *Service) listIdentitiesForm(w http.ResponseWriter, name, listTag string) {
	ids := []string{}
	svc.st.With(func(s *state.State) {
		for k := range s.SES.Identities {
			ids = append(ids, k)
		}
	})
	sort.Strings(ids)
	var members strings.Builder
	for _, e := range ids {
		members.WriteString("<member>" + respond.EscapeXML(e) + "</member>")
	}
	respond.XML(w, 200, `<?xml version="1.0"?><`+name+`Response><`+name+`Result><`+listTag+`>`+members.String()+`</`+listTag+`></`+name+`Result></`+name+`Response>`)
}

func (svc *Service) deleteIdentityForm(w http.ResponseWriter, p url.Values) {
	svc.st.With(func(s *state.State) { delete(s.SES.Identities, p.Get("Identity")) })
	respond.XML(w, 200, `<?xml version="1.0"?><DeleteIdentityResponse><DeleteIdentityResult/></DeleteIdentityResponse>`)
}

func (svc *Service) getSendQuotaForm(w http.ResponseWriter) {
	var sent float64
	svc.st.With(func(s *state.State) { sent = s.SES.Sent })
	respond.XML(w, 200, `<?xml version="1.0"?><GetSendQuotaResponse><GetSendQuotaResult><Max24HourSend>50000</Max24HourSend><MaxSendRate>14</MaxSendRate><SentLast24Hours>`+jsnum.Format(sent)+`</SentLast24Hours></GetSendQuotaResult></GetSendQuotaResponse>`)
}

func (svc *Service) getVerificationAttrsForm(w http.ResponseWriter, p url.Values) {
	var entries strings.Builder
	svc.st.With(func(s *state.State) {
		for i := 1; p.Has("Identities.member." + strconv.Itoa(i)); i++ {
			id := p.Get("Identities.member." + strconv.Itoa(i))
			status := "Pending"
			if _, ok := s.SES.Identities[id]; ok {
				status = "Success"
			}
			entries.WriteString("<entry><key>" + respond.EscapeXML(id) + "</key><value><VerificationStatus>" + status + "</VerificationStatus></value></entry>")
		}
	})
	respond.XML(w, 200, `<?xml version="1.0"?><GetIdentityVerificationAttributesResponse><GetIdentityVerificationAttributesResult><VerificationAttributes>`+entries.String()+`</VerificationAttributes></GetIdentityVerificationAttributesResult></GetIdentityVerificationAttributesResponse>`)
}
