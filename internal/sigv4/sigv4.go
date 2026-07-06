// Package sigv4 — opt-in AWS Signature V4 verification (port of
// src/middleware/sigv4.js). OFF unless MOCKCLOUD_VERIFY_SIGV4=true. When on,
// every AWS request is checked before dispatch: the Authorization-header or
// presigned-query signature is recomputed from the secret in
// store.iam.accessKeys and compared. The reconstruction targets the canonical
// form the SDK v3 clients produce for the requests MockCloud serves; exotic
// canonical-URI normalization (S3 key double-encoding) is out of scope.
package sigv4

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

type Error struct{ Code, Message string }

// Verify returns nil when the request is authentic, or an *Error to reject.
func Verify(r *httpapi.Request, st *store.Store) *Error {
	if r.Method == "OPTIONS" { // CORS preflight isn't signed
		return nil
	}
	if r.Query.Get("X-Amz-Algorithm") != "" {
		return verifyPresigned(r, st)
	}
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "AWS4-HMAC-SHA256") {
		return verifyHeaderAuth(r, st, auth)
	}
	return &Error{"MissingAuthenticationToken", "Request is missing Authentication Token"}
}

// SendError writes a 403 in the caller's protocol shape (JSON for
// json-protocol services, XML otherwise).
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

func lookupSecret(st *store.Store, accessKeyID string) (string, bool) {
	if accessKeyID == "" {
		return "", false
	}
	var secret string
	var ok bool
	st.With(func(s *state.State) { secret, ok = s.IAM.AccessKeys[accessKeyID] })
	return secret, ok
}

func invalidKey(accessKeyID string) *Error {
	return &Error{"InvalidAccessKeyId", "The AWS Access Key Id (" + accessKeyID + ") you provided does not exist in our records."}
}

// scopeSegments splits a credential scope into its first four segments —
// JS array destructuring semantics ("" for missing segments).
func scopeSegments(cred string) (akid, dateStamp, region, service string) {
	scope := strings.Split(cred, "/")
	seg := func(i int) string {
		if i < len(scope) {
			return scope[i]
		}
		return ""
	}
	return seg(0), seg(1), seg(2), seg(3)
}

var (
	credRe = regexp.MustCompile(`Credential=([^,\s]+)`)
	shRe   = regexp.MustCompile(`SignedHeaders=([^,\s]+)`)
	sigRe  = regexp.MustCompile(`Signature=([0-9a-fA-F]+)`)
)

func verifyHeaderAuth(r *httpapi.Request, st *store.Store, auth string) *Error {
	cred := submatch(credRe, auth)
	signedHeaders := submatch(shRe, auth)
	signature := submatch(sigRe, auth)
	if cred == "" || signedHeaders == "" || signature == "" {
		return &Error{"IncompleteSignature", "Authorization header requires Credential, SignedHeaders and Signature."}
	}
	// akid/date/region/service/aws4_request — Node destructures with undefined
	// for missing segments (short scopes still hit the akid lookup below).
	accessKeyID, dateStamp, region, service := scopeSegments(cred)
	secret, ok := lookupSecret(st, accessKeyID)
	if !ok {
		return invalidKey(accessKeyID)
	}
	amzDate := r.Header.Get("x-amz-date")
	payloadHash := r.Header.Get("x-amz-content-sha256")
	if payloadHash == "" {
		payloadHash = sha256hex(r.RawBody)
	}
	canonical := buildCanonicalRequest(r, r.URL.EscapedPath(), canonicalQueryString(r, ""), signedHeaders, payloadHash)
	expected := computeSignature(secret, dateStamp, region, service, amzDate, canonical)
	if matches(expected, signature) {
		return nil
	}
	return &Error{"SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method."}
}

func verifyPresigned(r *httpapi.Request, st *store.Store) *Error {
	q := r.Query
	cred := q.Get("X-Amz-Credential")
	accessKeyID, dateStamp, region, service := scopeSegments(cred)
	secret, ok := lookupSecret(st, accessKeyID)
	if !ok {
		return invalidKey(accessKeyID)
	}
	signedMs := parseAmzDate(q.Get("X-Amz-Date"))
	// Node: parseInt(q.get('X-Amz-Expires') || '0', 10) — digit-prefix parse;
	// NaN comparisons are false in Go exactly like JS, so a non-numeric value
	// passes both the <=0 gate and the expiry check (Node quirk, kept).
	expStr := q.Get("X-Amz-Expires")
	if expStr == "" {
		expStr = "0"
	}
	expires := jsnum.ParseIntPrefix(expStr)
	if signedMs == 0 || expires <= 0 {
		return &Error{"AuthorizationQueryParametersError", "Invalid X-Amz-Date or X-Amz-Expires"}
	}
	if float64(state.NowMs()) > float64(signedMs)+expires*1000 {
		return &Error{"AccessDenied", "Request has expired"}
	}
	signedHeaders := q.Get("X-Amz-SignedHeaders")
	if signedHeaders == "" {
		signedHeaders = "host"
	}
	provided := q.Get("X-Amz-Signature")
	canonical := buildCanonicalRequest(r, r.URL.EscapedPath(), canonicalQueryString(r, "X-Amz-Signature"), signedHeaders, "UNSIGNED-PAYLOAD")
	expected := computeSignature(secret, dateStamp, region, service, q.Get("X-Amz-Date"), canonical)
	if matches(expected, provided) {
		return nil
	}
	return &Error{"SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided. Check your key and signing method."}
}

// ── Canonicalization ─────────────────────────────────────────────────────────

func buildCanonicalRequest(r *httpapi.Request, uri, query, signedHeaders, payloadHash string) string {
	if uri == "" {
		uri = "/"
	}
	var canonicalHeaders strings.Builder
	for _, n := range strings.Split(signedHeaders, ";") {
		canonicalHeaders.WriteString(n + ":" + headerValue(r, n) + "\n")
	}
	return strings.Join([]string{r.Method, uri, query, canonicalHeaders.String(), signedHeaders, payloadHash}, "\n")
}

var wsRe = regexp.MustCompile(`\s+`)

// headerValue reads a signed header (lowercased name), trims and collapses
// internal whitespace. host lives in r.Host, not r.Header (Go quirk).
func headerValue(r *httpapi.Request, name string) string {
	var raw string
	if name == "host" {
		raw = r.Host
	} else {
		raw = strings.Join(r.Header.Values(http.CanonicalHeaderKey(name)), ",")
	}
	return wsRe.ReplaceAllString(strings.TrimSpace(raw), " ")
}

// canonicalQueryString re-encodes and sorts the query params. Uses RawQuery
// pair-by-pair (preserving duplicates) rather than the url.Values map.
func canonicalQueryString(r *httpapi.Request, exclude string) string {
	type pair struct{ k, v string }
	var pairs []pair
	for _, seg := range strings.Split(r.URL.RawQuery, "&") {
		if seg == "" {
			continue
		}
		k, v, _ := strings.Cut(seg, "=")
		dk := queryUnescape(k)
		if exclude != "" && dk == exclude {
			continue
		}
		pairs = append(pairs, pair{awsURIEncode(dk), awsURIEncode(queryUnescape(v))})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})
	out := make([]string, len(pairs))
	for i, p := range pairs {
		out[i] = p.k + "=" + p.v
	}
	return strings.Join(out, "&")
}

// queryUnescape decodes a query component (+ → space, %XX), matching
// URLSearchParams; leaves malformed escapes as-is.
func queryUnescape(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if hi, ok := hexVal(s[i+1]); ok {
				if lo, ok2 := hexVal(s[i+2]); ok2 {
					b.WriteByte(hi<<4 | lo)
					i += 2
					continue
				}
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func hexVal(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// awsURIEncode — RFC-3986 strict (unreserved A-Za-z0-9-_.~), uppercase hex.
func awsURIEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteString(strings.ToUpper(hex.EncodeToString([]byte{c})))
		}
	}
	return b.String()
}

// ── Signing ──────────────────────────────────────────────────────────────────

func computeSignature(secret, dateStamp, region, service, amzDate, canonicalRequest string) string {
	scope := dateStamp + "/" + region + "/" + service + "/aws4_request"
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, sha256hex([]byte(canonicalRequest))}, "\n")
	kDate := hmacSHA([]byte("AWS4"+secret), dateStamp)
	kRegion := hmacSHA(kDate, region)
	kService := hmacSHA(kRegion, service)
	kSigning := hmacSHA(kService, "aws4_request")
	return hex.EncodeToString(hmacSHA(kSigning, stringToSign))
}

func hmacSHA(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

func sha256hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func matches(expectedHex, providedHex string) bool {
	if providedHex == "" || len(expectedHex) != len(providedHex) {
		return false
	}
	eb, err1 := hex.DecodeString(expectedHex)
	pb, err2 := hex.DecodeString(providedHex)
	if err1 != nil || err2 != nil {
		return false
	}
	return subtle.ConstantTimeCompare(eb, pb) == 1
}

func submatch(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

var amzDateRe = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$`)

func parseAmzDate(s string) int64 {
	m := amzDateRe.FindStringSubmatch(s)
	if m == nil {
		return 0
	}
	atoi := func(x string) int { n, _ := strconv.Atoi(x); return n }
	return time.Date(atoi(m[1]), time.Month(atoi(m[2])), atoi(m[3]), atoi(m[4]), atoi(m[5]), atoi(m[6]), 0, time.UTC).UnixMilli()
}
