package s3

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/state"
)

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func orEmpty(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

func headerOr(r *httpapi.Request, name, fallback string) string {
	if v := r.Header.Get(name); v != "" {
		return v
	}
	return fallback
}

func firstMatch(s, pattern string) string {
	if m := regexp.MustCompile(pattern).FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

func newVersionID() string { return state.RandomID(32) }

// ── Disk persistence ─────────────────────────────────────────────────────────
// Keys can contain '/'; that mirrors into the directory tree. safeJoin keeps
// every resolved path inside S3_ROOT (bucket-name validation is the first
// line of defense; this is the second). '..' key segments become '__'.

func safeKey(key string) string {
	parts := strings.Split(key, "/")
	for i, p := range parts {
		if p == ".." {
			parts[i] = "__"
		}
	}
	return strings.Join(parts, "/")
}

func (s *Service) safeJoin(parts ...string) (string, error) {
	absRoot, err := filepath.Abs(s.cfg.S3Root)
	if err != nil {
		return "", err
	}
	target := filepath.Join(append([]string{absRoot}, parts...)...)
	if target == absRoot {
		return target, nil
	}
	rel, err := filepath.Rel(absRoot, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", errors.New("path escape")
	}
	return target, nil
}

func (s *Service) diskPath(bucket, key string) (string, error) {
	return s.safeJoin(bucket, filepath.FromSlash(safeKey(key)))
}

func (s *Service) writeObject(bucket, key string, buf []byte) error {
	target, err := s.diskPath(bucket, key)
	if err != nil {
		return err
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

// Historical versions live in a sidecar dir so the current-head file (read by
// GET-without-versionId and disk hydration) is untouched.
func (s *Service) versionDiskPath(bucket, key, versionID string) string {
	return filepath.Join(s.cfg.S3Root, bucket, ".mockcloud-versions", filepath.FromSlash(safeKey(key)), versionID)
}

func (s *Service) writeVersion(bucket, key, versionID string, buf []byte) error {
	target := s.versionDiskPath(bucket, key, versionID)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return os.WriteFile(target, buf, 0o644)
}

// Multipart parts live in a per-upload sidecar dir (skipped by hydration).
func (s *Service) mpuDir(bucket, uploadID string) string {
	return filepath.Join(s.cfg.S3Root, bucket, ".mockcloud-mpu", uploadID)
}

func (s *Service) writeMpuPart(bucket, uploadID string, partNumber int, buf []byte) error {
	dir := s.mpuDir(bucket, uploadID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, strconv.Itoa(partNumber)), buf, 0o644)
}

// HydrateFromDisk loads pre-existing buckets/objects at startup (Node ran
// this at module load). Objects >5MB get a synthetic etag to keep boot fast.
func (s *Service) HydrateFromDisk() {
	entries, err := os.ReadDir(s.cfg.S3Root)
	if err != nil {
		return
	}
	s.st.With(func(st *state.State) {
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			bucketName := entry.Name()
			// Skip dirs whose names couldn't have come through the API so a
			// traversal-named bucket can't resurrect on restart.
			if !bucketNameRe.MatchString(bucketName) {
				continue
			}
			if st.S3.Buckets[bucketName] != nil {
				continue
			}
			bucketPath, err := s.safeJoin(bucketName)
			if err != nil {
				continue
			}
			objects := map[string]*state.ObjectMeta{}
			walkObjects(bucketPath, "", objects)
			st.S3.Buckets[bucketName] = &state.Bucket{
				Name: bucketName, Region: "us-east-1", Created: safeMtime(bucketPath),
				Objects:        objects,
				ObjectVersions: map[string][]*state.ObjectMeta{}, MultipartUploads: map[string]*state.MPU{},
			}
		}
	})
}

func walkObjects(dir, prefix string, out map[string]*state.ObjectMeta) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if name == ".mockcloud-versions" || name == ".mockcloud-mpu" || strings.Contains(name, ".tmp-") {
			continue
		}
		full := filepath.Join(dir, name)
		key := name
		if prefix != "" {
			key = prefix + "/" + name
		}
		if e.IsDir() {
			walkObjects(full, key, out)
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		var etag string
		if info.Size() <= 5*1024*1024 {
			data, err := os.ReadFile(full)
			if err != nil {
				continue
			}
			sum := md5.Sum(data)
			etag = hex.EncodeToString(sum[:])
		} else {
			sum := md5.Sum([]byte(fmt.Sprintf("%d-%d", info.Size(), info.ModTime().UnixMilli())))
			etag = hex.EncodeToString(sum[:])
		}
		out[key] = &state.ObjectMeta{
			Key: key, Size: info.Size(), ContentType: "application/octet-stream",
			ETag: etag, Modified: info.ModTime().UnixMilli(), Metadata: map[string]string{},
		}
	}
}

func safeMtime(p string) int64 {
	if info, err := os.Stat(p); err == nil {
		return info.ModTime().UnixMilli()
	}
	return state.NowMs()
}

func extractMetadata(h http.Header) map[string]string {
	meta := map[string]string{}
	for k, vals := range h {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "x-amz-meta-") && len(vals) > 0 {
			meta[lk[len("x-amz-meta-"):]] = vals[0]
		}
	}
	return meta
}

func findVersion(b *state.Bucket, key, versionID string) *state.ObjectMeta {
	for _, v := range b.ObjectVersions[key] {
		if deref(v.VersionID) == versionID {
			return v
		}
	}
	return nil
}

// ── Conditional requests → 412 | 304 | 0 ─────────────────────────────────────

func checkConditional(r *httpapi.Request, obj *state.ObjectMeta) int {
	im, inm := r.Header.Get("If-Match"), r.Header.Get("If-None-Match")
	ius, ims := r.Header.Get("If-Unmodified-Since"), r.Header.Get("If-Modified-Since")
	matches := func(h string) bool {
		for _, t := range strings.Split(h, ",") {
			t = strings.TrimSpace(t)
			if t == "*" {
				return true
			}
			t = strings.TrimPrefix(t, "W/")
			t = strings.Trim(t, `"`)
			if t == obj.ETag {
				return true
			}
		}
		return false
	}
	objTime := time.UnixMilli(obj.Modified)
	if im != "" && !matches(im) {
		return 412
	}
	if ius != "" {
		if t, err := http.ParseTime(ius); err == nil && objTime.After(t) {
			return 412
		}
	}
	if inm != "" && matches(inm) {
		return 304
	}
	if ims != "" {
		if t, err := http.ParseTime(ims); err == nil && !objTime.After(t) {
			return 304
		}
	}
	return 0
}

// ── Range header → (start, end, kind) ────────────────────────────────────────

type rangeKind int

const (
	rangeNone rangeKind = iota
	rangeOK
	rangeInvalid
)

var rangeRe = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

func parseRange(header string, total int64) (int64, int64, rangeKind) {
	if header == "" {
		return 0, 0, rangeNone
	}
	m := rangeRe.FindStringSubmatch(strings.TrimSpace(header))
	if m == nil || (m[1] == "" && m[2] == "") {
		return 0, 0, rangeNone
	}
	var start, end int64
	hasStart, hasEnd := m[1] != "", m[2] != ""
	if hasStart {
		start, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if hasEnd {
		end, _ = strconv.ParseInt(m[2], 10, 64)
	}
	if !hasStart { // suffix range: bytes=-N
		start = total - end
		if start < 0 {
			start = 0
		}
		end = total - 1
	} else if !hasEnd || end >= total {
		end = total - 1
	}
	if start > end || start >= total {
		return 0, 0, rangeInvalid
	}
	return start, end, rangeOK
}

// Parse an X-Amz-Date stamp (YYYYMMDDTHHMMSSZ, UTC) to epoch ms; 0 = invalid.
var amzDateRe = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$`)

func parseAmzDate(s string) int64 {
	m := amzDateRe.FindStringSubmatch(s)
	if m == nil {
		return 0
	}
	atoi := func(x string) int { n, _ := strconv.Atoi(x); return n }
	return time.Date(atoi(m[1]), time.Month(atoi(m[2])), atoi(m[3]),
		atoi(m[4]), atoi(m[5]), atoi(m[6]), 0, time.UTC).UnixMilli()
}

func xmlUnescape(s string) string {
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&quot;", `"`)
	s = strings.ReplaceAll(s, "&apos;", "'")
	s = strings.ReplaceAll(s, "&amp;", "&") // amp LAST, matching Node
	return s
}

// ── CORS rules ───────────────────────────────────────────────────────────────

var corsRuleRe = regexp.MustCompile(`(?s)<CORSRule>(.*?)</CORSRule>`)
var maxAgeRe = regexp.MustCompile(`<MaxAgeSeconds>(\d+)</MaxAgeSeconds>`)

func parseCorsRules(xml string) []state.CorsRule {
	var rules []state.CorsRule
	for _, m := range corsRuleRe.FindAllStringSubmatch(xml, -1) {
		inner := m[1]
		rule := state.CorsRule{
			AllowedOrigins: allTagValues(inner, "AllowedOrigin"),
			AllowedMethods: allTagValues(inner, "AllowedMethod"),
			AllowedHeaders: allTagValues(inner, "AllowedHeader"),
			ExposeHeaders:  allTagValues(inner, "ExposeHeader"),
		}
		if am := maxAgeRe.FindStringSubmatch(inner); am != nil {
			n, _ := strconv.Atoi(am[1])
			rule.MaxAgeSeconds = &n
		}
		rules = append(rules, rule)
	}
	return rules
}

func allTagValues(xml, tag string) []string {
	re := regexp.MustCompile(`<` + tag + `>([^<]*)</` + tag + `>`)
	out := []string{}
	for _, m := range re.FindAllStringSubmatch(xml, -1) {
		out = append(out, m[1])
	}
	return out
}

// matchCorsRule finds a rule whose methods include method and whose origins
// include origin (exact, '*', or wildcard pattern).
func matchCorsRule(rules []state.CorsRule, origin, method string) *state.CorsRule {
	meth := strings.ToUpper(method)
	for i := range rules {
		r := &rules[i]
		methodOK := false
		for _, m := range r.AllowedMethods {
			if strings.ToUpper(m) == meth {
				methodOK = true
				break
			}
		}
		if !methodOK {
			continue
		}
		for _, o := range r.AllowedOrigins {
			if o == "*" || o == origin || corsOriginMatch(o, origin) {
				return r
			}
		}
	}
	return nil
}

func corsOriginMatch(pattern, value string) bool {
	if !strings.Contains(pattern, "*") {
		return pattern == value
	}
	parts := strings.Split(pattern, "*")
	for i, p := range parts {
		parts[i] = regexp.QuoteMeta(p)
	}
	re, err := regexp.Compile("^" + strings.Join(parts, ".*") + "$")
	return err == nil && re.MatchString(value)
}

// ── Bucket notifications ─────────────────────────────────────────────────────

func parseNotificationConfig(xml string) []state.NotifConfig {
	var out []state.NotifConfig
	grab := func(blockTag, arnTag, typ string) {
		blockRe := regexp.MustCompile(`(?s)<` + blockTag + `\b[^>]*>(.*?)</` + blockTag + `>`)
		arnRe := regexp.MustCompile(`<` + arnTag + `>([^<]+)</` + arnTag + `>`)
		evRe := regexp.MustCompile(`<Event>([^<]+)</Event>`)
		for _, m := range blockRe.FindAllStringSubmatch(xml, -1) {
			inner := m[1]
			arnM := arnRe.FindStringSubmatch(inner)
			if arnM == nil {
				continue
			}
			var events []string
			for _, e := range evRe.FindAllStringSubmatch(inner, -1) {
				events = append(events, e[1])
			}
			out = append(out, state.NotifConfig{
				Type: typ, Arn: strings.TrimSpace(arnM[1]), Events: events,
				Prefix: filterRuleValue(inner, "prefix"), Suffix: filterRuleValue(inner, "suffix"),
			})
		}
	}
	grab("QueueConfiguration", "Queue", "sqs")
	grab("TopicConfiguration", "Topic", "sns")
	grab("CloudFunctionConfiguration", "CloudFunction", "lambda")
	grab("LambdaFunctionConfiguration", "LambdaFunctionArn", "lambda")
	return out
}

func filterRuleValue(inner, name string) *string {
	re := regexp.MustCompile(`(?i)<FilterRule>\s*<Name>` + name + `</Name>\s*<Value>([^<]*)</Value>`)
	if m := re.FindStringSubmatch(inner); m != nil {
		return &m[1]
	}
	return nil
}

// 's3:ObjectCreated:*' matches 's3:ObjectCreated:Put'; exact names exactly.
func eventMatches(events []string, name string) bool {
	for _, e := range events {
		if e == name || (strings.HasSuffix(e, "*") && strings.HasPrefix(name, e[:len(e)-1])) {
			return true
		}
	}
	return false
}

// buildS3Event — the standard S3 event-notification envelope; eventName drops
// the 's3:' prefix, matching real records.
func buildS3Event(st *state.State, bucketName, key, eventName string, meta *state.ObjectMeta) map[string]any {
	region := "us-east-1"
	if b := st.S3.Buckets[bucketName]; b != nil && b.Region != "" {
		region = b.Region
	}
	object := map[string]any{"key": key, "size": meta.Size, "eTag": meta.ETag}
	if meta.VersionID != nil && *meta.VersionID != "" {
		object["versionId"] = *meta.VersionID
	}
	return map[string]any{"Records": []any{map[string]any{
		"eventVersion": "2.1",
		"eventSource":  "aws:s3",
		"awsRegion":    region,
		"eventTime":    state.ISO(state.NowMs()),
		"eventName":    strings.TrimPrefix(eventName, "s3:"),
		"s3": map[string]any{
			"s3SchemaVersion": "1.0",
			"bucket":          map[string]any{"name": bucketName, "arn": "arn:aws:s3:::" + bucketName},
			"object":          object,
		},
	}}}
}

// emitS3Event matches notification configs against an event and returns the
// delivery closures — fired by the caller AFTER the store lock is released
// (delivery re-enters the store via Lambda/SQS).
func (s *Service) emitS3Event(st *state.State, bucketName, key, eventName string, meta *state.ObjectMeta) []func() {
	var b *state.Bucket
	if b = st.S3.Buckets[bucketName]; b == nil || len(b.NotificationConfigs) == 0 {
		return nil
	}
	var out []func()
	for _, cfg := range b.NotificationConfigs {
		if !eventMatches(cfg.Events, eventName) {
			continue
		}
		if cfg.Prefix != nil && *cfg.Prefix != "" && !strings.HasPrefix(key, *cfg.Prefix) {
			continue
		}
		if cfg.Suffix != nil && *cfg.Suffix != "" && !strings.HasSuffix(key, *cfg.Suffix) {
			continue
		}
		event := buildS3Event(st, bucketName, key, eventName, meta)
		cfg := cfg
		if s.Deliver != nil {
			out = append(out, func() { s.Deliver(cfg, event) })
		}
	}
	return out
}
