// Package iampolicy — opt-in IAM policy evaluation (port of
// src/iam/policy-eval.js). OFF by default. MOCKCLOUD_IAM=soft logs would-be
// denials but never blocks; strict returns 403 AccessDenied. Combines the
// caller's identity policies with the target's resource policy: explicit Deny
// wins, else any matching Allow grants, else implicit deny. Only s3/sqs/sns/
// lambda/sts are enforced; the action/resource derivation and condition set
// are a documented subset, not full IAM fidelity.
package iampolicy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

// parseDate mirrors JS Date.parse for the ISO forms policies use → epoch ms.
func parseDate(s string) (int64, bool) {
	for _, layout := range []string{time.RFC3339, time.RFC3339Nano, "2006-01-02T15:04:05.000Z", "2006-01-02T15:04:05Z", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

type Error struct{ Code, Message string }

// Mode reads MOCKCLOUD_IAM → "off" | "soft" | "strict".
func Mode() string {
	switch strings.ToLower(os.Getenv("MOCKCLOUD_IAM")) {
	case "soft":
		return "soft"
	case "strict":
		return "strict"
	}
	return "off"
}

var enforced = map[string]struct{}{"s3": {}, "sqs": {}, "sns": {}, "lambda": {}, "sts": {}}

// Enforce returns nil when allowed/out-of-scope, or an *Error to block
// (strict only; soft logs and returns nil).
func Enforce(r *httpapi.Request, st *store.Store) *Error {
	if r.Method == "OPTIONS" {
		return nil
	}
	ctx := deriveContext(r, st)
	if ctx == nil {
		return nil
	}
	if _, ok := enforced[ctx.service]; !ok {
		return nil
	}
	effect, reason := decide(ctx)
	if effect == "Allow" {
		return nil
	}
	if Mode() == "soft" {
		fmt.Fprintf(os.Stderr, "[IAM soft] would DENY %s → %s on %s (%s)\n", ctx.principal, ctx.action, ctx.resource, reason)
		return nil
	}
	return &Error{"AccessDenied", "User: " + ctx.principal + " is not authorized to perform: " + ctx.action + " on resource: " + ctx.resource}
}

func SendError(w http.ResponseWriter, r *httpapi.Request, err *Error) {
	isJSON := r.Header.Get("x-amz-target") != "" || strings.Contains(strings.ToLower(r.Header.Get("content-type")), "json")
	reqID := state.RandomID(16)
	if isJSON {
		w.Header().Set("Content-Type", "application/x-amz-json-1.0")
		w.Header().Set("x-amzn-RequestId", reqID)
		w.WriteHeader(403)
		_, _ = w.Write(respond.Marshal(map[string]string{"__type": err.Code, "message": err.Message}))
		return
	}
	w.Header().Set("Content-Type", "application/xml")
	w.Header().Set("x-amzn-RequestId", reqID)
	w.WriteHeader(403)
	_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><ErrorResponse><Error><Code>` + err.Code +
		`</Code><Message>` + respond.EscapeXML(err.Message) + `</Message></Error><RequestId>` + reqID + `</RequestId></ErrorResponse>`))
}

// ── Decision ─────────────────────────────────────────────────────────────────

type evalCtx struct {
	principal          string
	service            string
	action             string
	resource           string
	ctxKeys            map[string]string
	identityStatements []map[string]any
	resourceStatements []map[string]any
}

func decide(ctx *evalCtx) (string, string) {
	idEffect := evalStatements(ctx.identityStatements, ctx)
	resEffect := evalStatements(ctx.resourceStatements, ctx)
	if idEffect == "Deny" || resEffect == "Deny" {
		return "Deny", "explicit Deny"
	}
	if idEffect == "Allow" || resEffect == "Allow" {
		return "Allow", ""
	}
	return "ImplicitDeny", "no matching Allow"
}

func evalStatements(statements []map[string]any, ctx *evalCtx) string {
	allow := false
	for _, st := range statements {
		if !statementMatches(st, ctx) {
			continue
		}
		effect, _ := st["Effect"].(string)
		if effect == "Deny" {
			return "Deny"
		}
		if effect == "Allow" {
			allow = true
		}
	}
	if allow {
		return "Allow"
	}
	return "NoMatch"
}

func statementMatches(st map[string]any, ctx *evalCtx) bool {
	return matchAction(st, ctx.action) && matchResource(st, ctx.resource) && matchConditions(st["Condition"], ctx.ctxKeys)
}

func matchAction(st map[string]any, action string) bool {
	a := strings.ToLower(action)
	if v, ok := st["Action"]; ok && v != nil {
		for _, p := range toArr(v) {
			if glob(strings.ToLower(toStr(p)), a) {
				return true
			}
		}
		return false
	}
	if v, ok := st["NotAction"]; ok && v != nil {
		for _, p := range toArr(v) {
			if glob(strings.ToLower(toStr(p)), a) {
				return false
			}
		}
		return true
	}
	return true
}

func matchResource(st map[string]any, resource string) bool {
	if v, ok := st["Resource"]; ok && v != nil {
		for _, p := range toArr(v) {
			if glob(toStr(p), resource) {
				return true
			}
		}
		return false
	}
	if v, ok := st["NotResource"]; ok && v != nil {
		for _, p := range toArr(v) {
			if glob(toStr(p), resource) {
				return false
			}
		}
		return true
	}
	return true
}

func matchConditions(cond any, keys map[string]string) bool {
	condMap, ok := cond.(map[string]any)
	if !ok || condMap == nil {
		return true
	}
	for op, raw := range condMap {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		for key, expected := range m {
			actual, present := keys[key]
			if !conditionOp(op, actual, present, expected) {
				return false
			}
		}
	}
	return true
}

func conditionOp(op, actual string, present bool, expected any) bool {
	exp := make([]string, 0)
	for _, e := range toArr(expected) {
		exp = append(exp, toStr(e))
	}
	switch op {
	case "StringEquals":
		return present && contains(exp, actual)
	case "StringNotEquals":
		return present && !contains(exp, actual)
	case "StringLike":
		return present && anyGlob(exp, actual)
	case "StringNotLike":
		return present && !anyGlob(exp, actual)
	case "Bool":
		return present && contains(exp, actual)
	case "IpAddress":
		return anyCidr(exp, actual, present)
	case "NotIpAddress":
		return !anyCidr(exp, actual, present)
	case "DateLessThan", "DateLessThanEquals", "DateGreaterThan", "DateGreaterThanEquals":
		return present && dateCompare(op, actual, exp)
	default:
		return true // unsupported operator → don't block on it
	}
}

// ── Context derivation ───────────────────────────────────────────────────────

var stsActions = map[string]struct{}{"AssumeRole": {}, "GetCallerIdentity": {}, "GetSessionToken": {}}
var snsActions = map[string]struct{}{"CreateTopic": {}, "DeleteTopic": {}, "Publish": {}, "PublishBatch": {}, "Subscribe": {}, "Unsubscribe": {}, "SetTopicAttributes": {}, "GetTopicAttributes": {}, "ListSubscriptionsByTopic": {}}

func deriveContext(r *httpapi.Request, st *store.Store) *evalCtx {
	principal := derivePrincipal(r)
	base := &evalCtx{
		principal: principal,
		ctxKeys: map[string]string{
			"aws:username":    principal,
			"aws:CurrentTime": state.ISO(state.NowMs()),
		},
		identityStatements: identityStatements(st, principal),
	}
	if ip := normalizeIP(r.RemoteAddr); ip != "" {
		base.ctxKeys["aws:SourceIp"] = ip
	}
	target := r.Header.Get("x-amz-target")
	json := r.ParsedBody
	form, _ := url.ParseQuery(string(r.RawBody))
	queryAction := r.Query.Get("Action")
	if queryAction == "" {
		queryAction = form.Get("Action")
	}

	// SQS (JSON target)
	if strings.HasPrefix(target, "AmazonSQS.") {
		queueURL := httpapi.Str(json, "QueueUrl")
		if queueURL == "" {
			queueURL = form.Get("QueueUrl")
		}
		name := lastSegment(queueURL, "/")
		resource := "*"
		if name != "" {
			resource = "arn:aws:sqs:us-east-1:000000000000:" + name
		}
		base.service = "sqs"
		base.action = "sqs:" + strings.SplitN(target, ".", 2)[1]
		base.resource = resource
		st.With(func(s *state.State) {
			if q := s.SQS.Queues[queueURL]; q != nil {
				base.resourceStatements = normalizeStatements(q.Attributes["Policy"])
			}
		})
		return base
	}
	// Lambda (REST paths or AWSLambda target)
	if strings.HasPrefix(target, "AWSLambda") || strings.Contains(r.URL.EscapedPath(), "/functions") {
		return deriveLambda(r, base)
	}
	// Query/form services
	if queryAction != "" {
		if _, ok := stsActions[queryAction]; ok {
			base.service, base.action, base.resource = "sts", "sts:"+queryAction, "*"
			return base
		}
		if _, ok := snsActions[queryAction]; ok {
			topicArn := httpapi.Str(json, "TopicArn")
			if topicArn == "" {
				topicArn = form.Get("TopicArn")
			}
			if topicArn == "" {
				topicArn = "*"
			}
			base.service, base.action, base.resource = "sns", "sns:"+queryAction, topicArn
			st.With(func(s *state.State) {
				if t := s.SNS.Topics[topicArn]; t != nil {
					base.resourceStatements = normalizeStatements(t.Attributes["Policy"])
				}
			})
			return base
		}
		base.service, base.action, base.resource = strings.ToLower(queryAction), queryAction, "*"
		return base
	}
	// Default: S3 (path-style)
	return deriveS3(r, st, base)
}

func deriveS3(r *httpapi.Request, st *store.Store, base *evalCtx) *evalCtx {
	var parts []string
	for _, p := range strings.Split(strings.TrimPrefix(r.URL.EscapedPath(), "/"), "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	bucket := ""
	if len(parts) > 0 {
		bucket = parts[0]
	}
	key := ""
	if len(parts) > 1 {
		key = strings.Join(parts[1:], "/")
	}
	action := "s3:ListAllMyBuckets"
	resource := "arn:aws:s3:::"
	switch {
	case bucket != "" && key != "":
		resource = "arn:aws:s3:::" + bucket + "/" + key
		action = mapOr(map[string]string{"GET": "s3:GetObject", "HEAD": "s3:GetObject", "PUT": "s3:PutObject", "POST": "s3:PutObject", "DELETE": "s3:DeleteObject"}, r.Method, "s3:GetObject")
	case bucket != "":
		resource = "arn:aws:s3:::" + bucket
		action = mapOr(map[string]string{"GET": "s3:ListBucket", "HEAD": "s3:ListBucket", "PUT": "s3:CreateBucket", "DELETE": "s3:DeleteBucket"}, r.Method, "s3:ListBucket")
	}
	base.service, base.action, base.resource = "s3", action, resource
	if bucket != "" {
		st.With(func(s *state.State) {
			if b := s.S3.Buckets[bucket]; b != nil && b.Policy != nil {
				base.resourceStatements = normalizeStatements(*b.Policy)
			}
		})
	}
	return base
}

var fnRe = regexp.MustCompile(`/functions/([^/?]+)`)

func deriveLambda(r *httpapi.Request, base *evalCtx) *evalCtx {
	path := r.URL.EscapedPath()
	name := ""
	if m := fnRe.FindStringSubmatch(path); m != nil {
		if dec, err := url.PathUnescape(m[1]); err == nil {
			name = dec
		} else {
			name = m[1]
		}
	}
	resource := "*"
	if name != "" {
		resource = "arn:aws:lambda:us-east-1:000000000000:function:" + name
	}
	action := "lambda:ListFunctions"
	switch {
	case strings.HasSuffix(path, "/invocations"):
		action = "lambda:InvokeFunction"
	case name != "" && r.Method == "GET":
		action = "lambda:GetFunction"
	case name != "" && r.Method == "DELETE":
		action = "lambda:DeleteFunction"
	case r.Method == "POST":
		action = "lambda:CreateFunction"
	}
	base.service, base.action, base.resource = "lambda", action, resource
	return base
}

func identityStatements(st *store.Store, principal string) []map[string]any {
	var out []map[string]any
	st.With(func(s *state.State) {
		docs, ok := s.IAM.IdentityPolicies[principal].([]any)
		if !ok {
			return
		}
		for _, doc := range docs {
			out = append(out, normalizeStatementsAny(doc)...)
		}
	})
	return out
}

func normalizeStatements(doc string) []map[string]any {
	if doc == "" {
		return nil
	}
	var parsed any
	if err := json.Unmarshal([]byte(doc), &parsed); err != nil {
		return nil
	}
	return normalizeStatementsAny(parsed)
}

func normalizeStatementsAny(doc any) []map[string]any {
	d, ok := doc.(map[string]any)
	if !ok {
		return nil
	}
	s := d["Statement"]
	switch v := s.(type) {
	case []any:
		out := make([]map[string]any, 0, len(v))
		for _, st := range v {
			if m, ok := st.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	case map[string]any:
		return []map[string]any{v}
	}
	return nil
}

func derivePrincipal(r *httpapi.Request) string {
	akid := ""
	if m := regexp.MustCompile(`Credential=([^/,\s]+)`).FindStringSubmatch(r.Header.Get("Authorization")); m != nil {
		akid = m[1]
	}
	if akid == "" {
		akid = strings.Split(r.Query.Get("X-Amz-Credential"), "/")[0]
	}
	if akid == "" {
		return "anonymous"
	}
	// accessKeyOwners maps akid → username when CreateAccessKey named a user.
	var owner string
	// The store lookup is done by the caller's identityStatements pass; do a
	// direct read here via a package-level hook set at wiring time.
	if ownerLookup != nil {
		owner = ownerLookup(akid)
	}
	if owner != "" {
		return owner
	}
	return akid
}

// ownerLookup resolves an access key id → owning username (set by dispatch
// wiring so this package needn't import store just for the map read).
var ownerLookup func(akid string) string

// SetOwnerLookup wires the accessKeyOwners resolver.
func SetOwnerLookup(fn func(akid string) string) { ownerLookup = fn }

// ── Helpers ──────────────────────────────────────────────────────────────────

func toArr(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	return []any{v}
}

func toStr(v any) string {
	switch s := v.(type) {
	case string:
		return s
	case bool:
		return strconv.FormatBool(s)
	case float64:
		return strconv.FormatFloat(s, 'g', -1, 64)
	case json.Number:
		return s.String()
	case nil:
		return ""
	}
	return fmt.Sprint(v)
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func anyGlob(patterns []string, value string) bool {
	for _, p := range patterns {
		if glob(p, value) {
			return true
		}
	}
	return false
}

func mapOr(m map[string]string, k, def string) string {
	if v, ok := m[k]; ok {
		return v
	}
	return def
}

func lastSegment(s, sep string) string {
	parts := strings.Split(s, sep)
	return parts[len(parts)-1]
}

// glob with `*` (any run) and `?` (one char); everything else literal.
func glob(pattern, value string) bool {
	if pattern == "*" {
		return true
	}
	var b strings.Builder
	b.WriteString("^")
	for _, c := range pattern {
		switch c {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	re, err := regexp.Compile(b.String())
	return err == nil && re.MatchString(value)
}

func normalizeIP(remoteAddr string) string {
	ip := remoteAddr
	if h, _, err := splitHostPort(remoteAddr); err == nil {
		ip = h
	}
	if ip == "" {
		return ""
	}
	if ip == "::1" {
		return "127.0.0.1"
	}
	if strings.HasPrefix(ip, "::ffff:") {
		return ip[7:]
	}
	return ip
}

func splitHostPort(hostport string) (string, string, error) {
	i := strings.LastIndex(hostport, ":")
	if i < 0 {
		return hostport, "", nil
	}
	// IPv6 without brackets (has multiple colons) — treat whole as host.
	if strings.Count(hostport, ":") > 1 && !strings.Contains(hostport, "]") {
		return hostport, "", nil
	}
	host := strings.TrimPrefix(strings.TrimSuffix(hostport[:i], "]"), "[")
	return host, hostport[i+1:], nil
}

func anyCidr(cidrs []string, ip string, present bool) bool {
	if !present {
		return false
	}
	for _, c := range cidrs {
		if ipInCIDR(ip, c) {
			return true
		}
	}
	return false
}

func ipInCIDR(ip, cidr string) bool {
	if ip == "" {
		return false
	}
	if !strings.Contains(cidr, "/") {
		return ip == cidr
	}
	rangeStr, bitsStr, _ := strings.Cut(cidr, "/")
	bits, err := strconv.Atoi(bitsStr)
	if err != nil {
		return false
	}
	a, ok1 := ipToInt(ip)
	b, ok2 := ipToInt(rangeStr)
	if !ok1 || !ok2 {
		return false
	}
	var mask uint32
	if bits == 0 {
		mask = 0
	} else {
		mask = ^uint32(0) << (32 - bits)
	}
	return (a & mask) == (b & mask)
}

func ipToInt(ip string) (uint32, bool) {
	p := strings.Split(ip, ".")
	if len(p) != 4 {
		return 0, false
	}
	var n uint32
	for _, part := range p {
		v, err := strconv.Atoi(part)
		if err != nil || v < 0 || v > 255 {
			return 0, false
		}
		n = n<<8 | uint32(v)
	}
	return n, true
}

func dateCompare(op, actual string, exp []string) bool {
	a, ok := parseDate(actual)
	if !ok {
		return false
	}
	for _, d := range exp {
		b, ok := parseDate(d)
		if !ok {
			continue
		}
		switch op {
		case "DateLessThan":
			if a < b {
				return true
			}
		case "DateLessThanEquals":
			if a <= b {
				return true
			}
		case "DateGreaterThan":
			if a > b {
				return true
			}
		case "DateGreaterThanEquals":
			if a >= b {
				return true
			}
		}
	}
	return false
}
