// Package s3 — full port of src/services/s3.js: bucket/object CRUD with disk
// persistence, multipart upload, CopyObject, Range/conditional GETs,
// DeleteObjects, virtual-host addressing, presigned-URL shape+expiry checks,
// versioning (version IDs, delete markers, head promotion), listings (V1/V2),
// bucket sub-resources, CORS rules, and notification-config storage.
//
// The whole handler runs inside ONE store.With section — the direct
// equivalent of Node's single event-loop turn (disk I/O included; Node
// blocked its loop on readFileSync/writeFileSync the same way). The only
// thing that must NOT run under the lock is notification delivery (it
// re-enters the store via Lambda/SQS), so emitS3Event collects closures the
// handler fires after the lock is released — matching Node's fire-and-forget
// async delivery.
package s3

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mockcloud/mockcloud/internal/config"
	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

// AWS bucket-naming rules — first line of defense against names like '../..'
// escaping S3_ROOT; safeJoin is the belt-and-braces backup.
var bucketNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

var s3HostRe = regexp.MustCompile(`^(.+?)\.s3(?:[.-][a-z0-9-]+)?\.(?:amazonaws\.com|localhost\.localstack\.cloud)$`)

var subResources = []string{
	"website", "acl", "publicAccessBlock", "versioning", "policy", "cors",
	"tagging", "logging", "versions", "notification", "uploads",
}

type Service struct {
	st  *store.Store
	cfg *config.Config
	// Deliver fires one matched notification config outside the store lock
	// (set by dispatch wiring: lambda in M3; sqs lands M5, sns M6). May be nil.
	Deliver func(cfg state.NotifConfig, event map[string]any)
}

func New(st *store.Store, cfg *config.Config) *Service { return &Service{st: st, cfg: cfg} }

func parseS3Host(host string) string {
	if host == "" {
		return ""
	}
	h := strings.ToLower(strings.Split(host, ":")[0])
	m := s3HostRe.FindStringSubmatch(h)
	if m == nil {
		return ""
	}
	return m[1]
}

func s3Error(w http.ResponseWriter, status int, code, message string) {
	respond.XML(w, status,
		`<?xml version="1.0"?><Error><Code>`+code+`</Code><Message>`+
			respond.EscapeXML(message)+`</Message></Error>`)
}

func iso(ms int64) string      { return state.ISO(ms) }
func httpDate(ms int64) string { return time.UnixMilli(ms).UTC().Format(http.TimeFormat) }

func (s *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	var after []func()
	s.st.With(func(st *state.State) {
		after = s.handle(w, r, st)
	})
	for _, fn := range after {
		go fn()
	}
}

//nolint:gocyclo // deliberate: the clause ORDER mirrors src/services/s3.js and is semantic.
func (s *Service) handle(w http.ResponseWriter, r *httpapi.Request, st *state.State) (after []func()) {
	method := r.Method
	q := r.Query
	hostBucket := parseS3Host(r.Host)
	rawPath := r.URL.EscapedPath()
	var pathParts []string
	for _, p := range strings.Split(strings.TrimPrefix(rawPath, "/"), "/") {
		if p != "" {
			pathParts = append(pathParts, p)
		}
	}
	if hostBucket != "" {
		pathParts = append([]string{hostBucket}, pathParts...)
	}

	// ── Presigned-URL expiry (shape + expiry only — no signature crypto;
	// that's the opt-in SigV4 middleware's job) ─────────────────────────────
	if q.Has("X-Amz-Algorithm") {
		for _, p := range []string{"X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-SignedHeaders", "X-Amz-Signature"} {
			if q.Get(p) == "" {
				s3Error(w, 403, "AccessDenied", "Invalid presigned request: missing "+p)
				return
			}
		}
		signedMs := parseAmzDate(q.Get("X-Amz-Date"))
		expires, _ := strconv.Atoi(q.Get("X-Amz-Expires"))
		if signedMs == 0 || expires <= 0 {
			s3Error(w, 403, "AccessDenied", "Invalid presigned request: bad X-Amz-Date or X-Amz-Expires")
			return
		}
		if state.NowMs() > signedMs+int64(expires)*1000 {
			s3Error(w, 403, "AccessDenied", "Request has expired")
			return
		}
	}

	// ── List all buckets ────────────────────────────────────────────────────
	if method == "GET" && rawPath == "/" && hostBucket == "" {
		names := make([]string, 0, len(st.S3.Buckets))
		for n := range st.S3.Buckets {
			names = append(names, n)
		}
		sort.Strings(names)
		var sb strings.Builder
		for _, n := range names {
			b := st.S3.Buckets[n]
			sb.WriteString("<Bucket><Name>" + respond.EscapeXML(b.Name) + "</Name><CreationDate>" + iso(b.Created) + "</CreationDate></Bucket>")
		}
		respond.XML(w, 200, `<?xml version="1.0"?><ListAllMyBucketsResult><Buckets>`+sb.String()+`</Buckets></ListAllMyBucketsResult>`)
		return
	}

	var bucketName, objectKey string
	if len(pathParts) > 0 {
		bucketName = pathParts[0]
	}
	if len(pathParts) > 1 {
		objectKey = strings.Join(pathParts[1:], "/")
	}

	if bucketName == "" {
		respond.XML(w, 200, `<?xml version="1.0"?><ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>`)
		return
	}

	// ── Per-bucket CORS reflection + preflight ──────────────────────────────
	origin := r.Header.Get("Origin")
	if origin != "" {
		var rules []state.CorsRule
		if b := st.S3.Buckets[bucketName]; b != nil {
			rules = b.CorsRules
		}
		reqMethod := r.Header.Get("Access-Control-Request-Method")
		if reqMethod == "" {
			reqMethod = method
		}
		if rule := matchCorsRule(rules, origin, reqMethod); rule != nil {
			if contains(rule.AllowedOrigins, "*") {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			} else {
				w.Header().Set("Access-Control-Allow-Origin", origin)
			}
			w.Header().Set("Vary", "Origin")
			if len(rule.ExposeHeaders) > 0 {
				w.Header().Set("Access-Control-Expose-Headers", strings.Join(rule.ExposeHeaders, ", "))
			}
		}
	}
	if method == "OPTIONS" {
		var rules []state.CorsRule
		if b := st.S3.Buckets[bucketName]; b != nil {
			rules = b.CorsRules
		}
		if origin != "" && len(rules) > 0 {
			reqMethod := r.Header.Get("Access-Control-Request-Method")
			if reqMethod == "" {
				reqMethod = "GET"
			}
			rule := matchCorsRule(rules, origin, reqMethod)
			if rule == nil {
				s3Error(w, 403, "AccessForbidden", "CORSResponse: This CORS request is not allowed.")
				return
			}
			allowOrigin := origin
			if contains(rule.AllowedOrigins, "*") {
				allowOrigin = "*"
			}
			allowHeaders := r.Header.Get("Access-Control-Request-Headers")
			if allowHeaders == "" {
				allowHeaders = strings.Join(rule.AllowedHeaders, ", ")
			}
			maxAge := 3000
			if rule.MaxAgeSeconds != nil && *rule.MaxAgeSeconds != 0 {
				maxAge = *rule.MaxAgeSeconds
			}
			w.Header().Set("Access-Control-Allow-Origin", allowOrigin)
			w.Header().Set("Access-Control-Allow-Methods", strings.Join(rule.AllowedMethods, ", "))
			w.Header().Set("Access-Control-Allow-Headers", allowHeaders)
			w.Header().Set("Access-Control-Max-Age", strconv.Itoa(maxAge))
			w.Header().Set("Vary", "Origin")
			w.WriteHeader(200)
			return
		}
		w.WriteHeader(204)
		return
	}

	// ── Create bucket (sub-resource PUTs also have no objectKey — skip them) ─
	hasSubResource := false
	for _, sr := range subResources {
		if q.Has(sr) {
			hasSubResource = true
			break
		}
	}
	if method == "PUT" && objectKey == "" && !hasSubResource {
		if !bucketNameRe.MatchString(bucketName) {
			s3Error(w, 400, "InvalidBucketName", "Bucket name does not match AWS naming rules")
			return
		}
		if st.S3.Buckets[bucketName] != nil {
			s3Error(w, 409, "BucketAlreadyOwnedByYou", "Bucket "+bucketName+" already exists")
			return
		}
		region := r.Header.Get("x-amz-bucket-region")
		if region == "" {
			region = "us-east-1"
		}
		st.S3.Buckets[bucketName] = &state.Bucket{
			Name: bucketName, Region: region, Created: state.NowMs(),
			Objects:        map[string]*state.ObjectMeta{},
			ObjectVersions: map[string][]*state.ObjectMeta{}, MultipartUploads: map[string]*state.MPU{},
			Website: nil, ACL: "private",
			PublicAccessBlock: &state.PublicAccessBlock{
				BlockPublicAcls: true, IgnorePublicAcls: true,
				BlockPublicPolicy: true, RestrictPublicBuckets: true,
			},
			Versioning: "Suspended",
		}
		if p, err := s.safeJoin(bucketName); err == nil {
			_ = os.MkdirAll(p, 0o755)
		}
		st.AddTrail(map[string]any{"method": "PUT", "path": "/s3/" + bucketName, "status": 200, "latency": 2})
		w.Header().Set("Location", "/"+bucketName)
		respond.XML(w, 200, "")
		return
	}

	// ── Bucket sub-resource: ?website ────────────────────────────────────────
	if objectKey == "" && q.Has("website") {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		switch method {
		case "PUT":
			raw := string(r.RawBody)
			idx := firstMatch(raw, `<Suffix>([^<]+)</Suffix>`)
			errDoc := firstMatch(raw, `<Key>([^<]+)</Key>`)
			if idx == "" {
				idx = "index.html"
			}
			if errDoc == "" {
				errDoc = "error.html"
			}
			bucket.Website = &state.WebsiteConfig{IndexDocument: idx, ErrorDocument: errDoc}
			w.WriteHeader(200)
			return
		case "GET":
			if bucket.Website == nil {
				s3Error(w, 404, "NoSuchWebsiteConfiguration", "The specified bucket does not have a website configuration")
				return
			}
			wc := bucket.Website
			respond.XML(w, 200, `<?xml version="1.0"?><WebsiteConfiguration><IndexDocument><Suffix>`+wc.IndexDocument+`</Suffix></IndexDocument><ErrorDocument><Key>`+wc.ErrorDocument+`</Key></ErrorDocument></WebsiteConfiguration>`)
			return
		case "DELETE":
			bucket.Website = nil
			w.WriteHeader(204)
			return
		}
	}

	// ── Bucket sub-resource: ?acl ────────────────────────────────────────────
	if objectKey == "" && q.Has("acl") {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		switch method {
		case "PUT":
			acl := r.Header.Get("x-amz-acl")
			if acl == "" {
				acl = "private"
			}
			bucket.ACL = acl
			w.WriteHeader(200)
			return
		case "GET":
			respond.XML(w, 200, `<?xml version="1.0"?><AccessControlPolicy><Owner><ID>mockcloud</ID><DisplayName>mockcloud</DisplayName></Owner><AccessControlList><Grant><Grantee><ID>mockcloud</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`)
			return
		}
	}

	// ── Bucket sub-resource: ?publicAccessBlock ──────────────────────────────
	if objectKey == "" && q.Has("publicAccessBlock") {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		switch method {
		case "PUT":
			raw := string(r.RawBody)
			bucket.PublicAccessBlock = &state.PublicAccessBlock{
				BlockPublicAcls:       strings.Contains(raw, "<BlockPublicAcls>true</BlockPublicAcls>"),
				IgnorePublicAcls:      strings.Contains(raw, "<IgnorePublicAcls>true</IgnorePublicAcls>"),
				BlockPublicPolicy:     strings.Contains(raw, "<BlockPublicPolicy>true</BlockPublicPolicy>"),
				RestrictPublicBuckets: strings.Contains(raw, "<RestrictPublicBuckets>true</RestrictPublicBuckets>"),
			}
			w.WriteHeader(200)
			return
		case "GET":
			p := bucket.PublicAccessBlock
			if p == nil {
				s3Error(w, 404, "NoSuchPublicAccessBlockConfiguration", "The public access block configuration was not found")
				return
			}
			respond.XML(w, 200, fmt.Sprintf(`<?xml version="1.0"?><PublicAccessBlockConfiguration><BlockPublicAcls>%t</BlockPublicAcls><IgnorePublicAcls>%t</IgnorePublicAcls><BlockPublicPolicy>%t</BlockPublicPolicy><RestrictPublicBuckets>%t</RestrictPublicBuckets></PublicAccessBlockConfiguration>`,
				p.BlockPublicAcls, p.IgnorePublicAcls, p.BlockPublicPolicy, p.RestrictPublicBuckets))
			return
		case "DELETE":
			bucket.PublicAccessBlock = nil
			w.WriteHeader(204)
			return
		}
	}

	// ── Bucket sub-resource: ?versioning ─────────────────────────────────────
	if objectKey == "" && q.Has("versioning") {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		switch method {
		case "PUT":
			status := firstMatch(string(r.RawBody), `<Status>([^<]+)</Status>`)
			if status == "" {
				status = "Suspended"
			}
			bucket.Versioning = status
			w.WriteHeader(200)
			return
		case "GET":
			inner := ""
			if bucket.Versioning != "" {
				inner = "<Status>" + bucket.Versioning + "</Status>"
			}
			respond.XML(w, 200, `<?xml version="1.0"?><VersioningConfiguration>`+inner+`</VersioningConfiguration>`)
			return
		}
	}

	// ── Bucket sub-resource: ?versions (ListObjectVersions) ──────────────────
	if objectKey == "" && q.Has("versions") && method == "GET" {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		prefix := q.Get("prefix")
		keySet := map[string]struct{}{}
		var keys []string
		for k := range bucket.Objects {
			if _, seen := keySet[k]; !seen {
				keySet[k] = struct{}{}
				keys = append(keys, k)
			}
		}
		for k := range bucket.ObjectVersions {
			if _, seen := keySet[k]; !seen {
				keySet[k] = struct{}{}
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		var versions, markers strings.Builder
		for _, key := range keys {
			if !strings.HasPrefix(key, prefix) {
				continue
			}
			history := bucket.ObjectVersions[key]
			if len(history) > 0 {
				for i, v := range history {
					latest := i == 0
					if v.IsDeleteMarker {
						markers.WriteString(fmt.Sprintf(`<DeleteMarker><Key>%s</Key><VersionId>%s</VersionId><IsLatest>%t</IsLatest><LastModified>%s</LastModified></DeleteMarker>`,
							respond.EscapeXML(key), deref(v.VersionID), latest, iso(v.Modified)))
					} else {
						versions.WriteString(fmt.Sprintf(`<Version><Key>%s</Key><VersionId>%s</VersionId><IsLatest>%t</IsLatest><LastModified>%s</LastModified><ETag>&quot;%s&quot;</ETag><Size>%d</Size><StorageClass>STANDARD</StorageClass></Version>`,
							respond.EscapeXML(key), deref(v.VersionID), latest, iso(v.Modified), v.ETag, v.Size))
					}
				}
			} else if o := bucket.Objects[key]; o != nil && !o.IsDeleteMarker {
				versions.WriteString(fmt.Sprintf(`<Version><Key>%s</Key><VersionId>null</VersionId><IsLatest>true</IsLatest><LastModified>%s</LastModified><ETag>&quot;%s&quot;</ETag><Size>%d</Size><StorageClass>STANDARD</StorageClass></Version>`,
					respond.EscapeXML(key), iso(o.Modified), o.ETag, o.Size))
			}
		}
		respond.XML(w, 200,
			`<?xml version="1.0"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>`+respond.EscapeXML(bucketName)+`</Name><Prefix>`+respond.EscapeXML(prefix)+`</Prefix><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>`+versions.String()+markers.String()+`</ListVersionsResult>`)
		return
	}

	// ── Bucket sub-resource: ?policy ─────────────────────────────────────────
	if objectKey == "" && q.Has("policy") {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		switch method {
		case "PUT":
			p := string(r.RawBody)
			bucket.Policy = &p
			w.WriteHeader(204)
			return
		case "GET":
			if bucket.Policy == nil || *bucket.Policy == "" {
				s3Error(w, 404, "NoSuchBucketPolicy", "The bucket policy does not exist")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
			_, _ = w.Write([]byte(*bucket.Policy))
			return
		case "DELETE":
			bucket.Policy = nil
			w.WriteHeader(204)
			return
		}
	}

	// ── Bucket sub-resource: ?cors ───────────────────────────────────────────
	if objectKey == "" && q.Has("cors") {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		switch method {
		case "PUT":
			raw := string(r.RawBody) // kept verbatim for GET round-trips
			bucket.Cors = &raw
			bucket.CorsRules = parseCorsRules(raw)
			w.WriteHeader(200)
			return
		case "GET":
			if bucket.Cors == nil || *bucket.Cors == "" {
				s3Error(w, 404, "NoSuchCORSConfiguration", "No CORS configuration")
				return
			}
			respond.XML(w, 200, *bucket.Cors)
			return
		case "DELETE":
			bucket.Cors = nil
			bucket.CorsRules = nil
			w.WriteHeader(204)
			return
		}
	}

	// ── Bucket sub-resource: ?notification ───────────────────────────────────
	if objectKey == "" && q.Has("notification") {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		switch method {
		case "PUT":
			raw := string(r.RawBody)
			bucket.NotificationXml = raw // kept verbatim for GET round-trips
			bucket.NotificationConfigs = parseNotificationConfig(raw)
			w.WriteHeader(200)
			return
		case "GET":
			body := bucket.NotificationXml
			if body == "" {
				body = `<?xml version="1.0" encoding="UTF-8"?><NotificationConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></NotificationConfiguration>`
			}
			respond.XML(w, 200, body)
			return
		}
	}

	// ── Bucket sub-resource: ?tagging ────────────────────────────────────────
	if objectKey == "" && q.Has("tagging") {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		switch method {
		case "PUT":
			tags := map[string]string{}
			tagRe := regexp.MustCompile(`<Tag><Key>([^<]*)</Key><Value>([^<]*)</Value></Tag>`)
			for _, m := range tagRe.FindAllStringSubmatch(string(r.RawBody), -1) {
				tags[m[1]] = m[2]
			}
			bucket.Tags = tags
			w.WriteHeader(204)
			return
		case "GET":
			keys := make([]string, 0, len(bucket.Tags))
			for k := range bucket.Tags {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			var sb strings.Builder
			for _, k := range keys {
				sb.WriteString("<Tag><Key>" + respond.EscapeXML(k) + "</Key><Value>" + respond.EscapeXML(bucket.Tags[k]) + "</Value></Tag>")
			}
			respond.XML(w, 200, `<?xml version="1.0" encoding="UTF-8"?><Tagging><TagSet>`+sb.String()+`</TagSet></Tagging>`)
			return
		case "DELETE":
			bucket.Tags = map[string]string{}
			w.WriteHeader(204)
			return
		}
	}

	// ── Delete bucket ─────────────────────────────────────────────────────────
	if method == "DELETE" && objectKey == "" {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		if len(bucket.Objects) > 0 {
			s3Error(w, 409, "BucketNotEmpty", "The bucket you tried to delete is not empty")
			return
		}
		delete(st.S3.Buckets, bucketName)
		if p, err := s.safeJoin(bucketName); err == nil {
			_ = os.RemoveAll(p)
		}
		st.AddTrail(map[string]any{"method": "DELETE", "path": "/s3/" + bucketName, "status": 204, "latency": 1})
		w.WriteHeader(204)
		return
	}

	// ── Head bucket ───────────────────────────────────────────────────────────
	if method == "HEAD" && objectKey == "" {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("x-amz-bucket-region", bucket.Region)
		w.WriteHeader(200)
		return
	}

	// ── List multipart uploads (bucket-level GET /?uploads) ───────────────────
	if method == "GET" && objectKey == "" && q.Has("uploads") {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		ids := make([]string, 0, len(bucket.MultipartUploads))
		for id := range bucket.MultipartUploads {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		var sb strings.Builder
		for _, id := range ids {
			u := bucket.MultipartUploads[id]
			sb.WriteString("<Upload><Key>" + respond.EscapeXML(u.Key) + "</Key><UploadId>" + u.UploadID + "</UploadId><StorageClass>STANDARD</StorageClass><Initiated>" + iso(u.Initiated) + "</Initiated></Upload>")
		}
		respond.XML(w, 200,
			`<?xml version="1.0"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>`+respond.EscapeXML(bucketName)+`</Bucket><KeyMarker/><UploadIdMarker/><MaxUploads>1000</MaxUploads><IsTruncated>false</IsTruncated>`+sb.String()+`</ListMultipartUploadsResult>`)
		return
	}

	// ── Delete multiple objects (POST /?delete) ───────────────────────────────
	if method == "POST" && objectKey == "" && q.Has("delete") {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		raw := string(r.RawBody)
		quiet := regexp.MustCompile(`(?i)<Quiet>\s*true\s*</Quiet>`).MatchString(raw)
		var deleted []string
		objRe := regexp.MustCompile(`(?s)<Object>(.*?)</Object>`)
		keyRe := regexp.MustCompile(`(?s)<Key>(.*?)</Key>`)
		verRe := regexp.MustCompile(`(?s)<VersionId>(.*?)</VersionId>`)
		for _, m := range objRe.FindAllStringSubmatch(raw, -1) {
			keyM := keyRe.FindStringSubmatch(m[1])
			if keyM == nil {
				continue
			}
			key := xmlUnescape(keyM[1])
			versionID := ""
			if vm := verRe.FindStringSubmatch(m[1]); vm != nil {
				versionID = vm[1]
			}
			switch {
			case versionID != "":
				hist := bucket.ObjectVersions[key]
				idx := -1
				for i, v := range hist {
					if deref(v.VersionID) == versionID {
						idx = i
						break
					}
				}
				if idx >= 0 {
					hist = append(hist[:idx], hist[idx+1:]...)
					bucket.ObjectVersions[key] = hist
					_ = os.Remove(s.versionDiskPath(bucketName, key, versionID))
					if len(hist) == 0 {
						delete(bucket.ObjectVersions, key)
						delete(bucket.Objects, key)
						if p, err := s.diskPath(bucketName, key); err == nil {
							_ = os.Remove(p)
						}
					} else if idx == 0 {
						bucket.Objects[key] = hist[0]
					}
				}
				deleted = append(deleted, "<Deleted><Key>"+respond.EscapeXML(key)+"</Key><VersionId>"+versionID+"</VersionId></Deleted>")
			case bucket.Versioning == "Enabled":
				vid := newVersionID()
				marker := &state.ObjectMeta{Key: key, IsDeleteMarker: true, VersionID: &vid, Modified: state.NowMs()}
				bucket.ObjectVersions[key] = append([]*state.ObjectMeta{marker}, bucket.ObjectVersions[key]...)
				bucket.Objects[key] = marker
				deleted = append(deleted, "<Deleted><Key>"+respond.EscapeXML(key)+"</Key><DeleteMarker>true</DeleteMarker><DeleteMarkerVersionId>"+vid+"</DeleteMarkerVersionId></Deleted>")
			default:
				delete(bucket.Objects, key)
				if p, err := s.diskPath(bucketName, key); err == nil {
					_ = os.Remove(p)
				}
				deleted = append(deleted, "<Deleted><Key>"+respond.EscapeXML(key)+"</Key></Deleted>")
			}
			after = append(after, s.emitS3Event(st, bucketName, key, "s3:ObjectRemoved:Delete", &state.ObjectMeta{Key: key})...)
		}
		inner := ""
		if !quiet {
			inner = strings.Join(deleted, "")
		}
		respond.XML(w, 200, `<?xml version="1.0"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`+inner+`</DeleteResult>`)
		return
	}

	// ── List objects (V1 + V2, paginated) ────────────────────────────────────
	if method == "GET" && objectKey == "" {
		bucket := st.S3.Buckets[bucketName]
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "Bucket "+bucketName+" does not exist")
			return
		}
		prefix := q.Get("prefix")
		maxKeys := 1000
		if mk := q.Get("max-keys"); mk != "" {
			if n, err := strconv.Atoi(mk); err == nil && n >= 0 {
				maxKeys = n
			} else {
				maxKeys = 0
			}
		}
		isV2 := q.Get("list-type") == "2"
		var token string
		if isV2 {
			token = q.Get("continuation-token")
		} else {
			token = q.Get("marker")
		}
		after_ := ""
		if token != "" {
			if dec, err := base64.StdEncoding.DecodeString(token); err == nil {
				after_ = string(dec)
			}
		} else if isV2 {
			after_ = q.Get("start-after")
		}

		var objs []*state.ObjectMeta
		for _, o := range bucket.Objects {
			if strings.HasPrefix(o.Key, prefix) && !o.IsDeleteMarker {
				objs = append(objs, o)
			}
		}
		sort.Slice(objs, func(i, j int) bool { return objs[i].Key < objs[j].Key })
		if after_ != "" {
			kept := objs[:0]
			for _, o := range objs {
				if o.Key > after_ {
					kept = append(kept, o)
				}
			}
			objs = kept
		}
		page := objs
		if len(page) > maxKeys {
			page = page[:maxKeys]
		}
		isTruncated := len(objs) > maxKeys
		nextToken := ""
		if isTruncated && len(page) > 0 {
			nextToken = base64.StdEncoding.EncodeToString([]byte(page[len(page)-1].Key))
		}

		var contents strings.Builder
		for _, o := range page {
			contents.WriteString(fmt.Sprintf(`<Contents><Key>%s</Key><Size>%d</Size><LastModified>%s</LastModified><ETag>&quot;%s&quot;</ETag><StorageClass>STANDARD</StorageClass></Contents>`,
				respond.EscapeXML(o.Key), o.Size, iso(o.Modified), o.ETag))
		}

		var pageMeta strings.Builder
		if isV2 {
			pageMeta.WriteString(fmt.Sprintf("<KeyCount>%d</KeyCount>", len(page)))
			if token != "" {
				pageMeta.WriteString("<ContinuationToken>" + respond.EscapeXML(token) + "</ContinuationToken>")
			}
			if nextToken != "" {
				pageMeta.WriteString("<NextContinuationToken>" + nextToken + "</NextContinuationToken>")
			}
		} else {
			if after_ != "" {
				pageMeta.WriteString("<Marker>" + respond.EscapeXML(after_) + "</Marker>")
			} else {
				pageMeta.WriteString("<Marker></Marker>")
			}
			if isTruncated && len(page) > 0 {
				pageMeta.WriteString("<NextMarker>" + respond.EscapeXML(page[len(page)-1].Key) + "</NextMarker>")
			}
		}
		respond.XML(w, 200, fmt.Sprintf(`<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>%s</Name><Prefix>%s</Prefix><MaxKeys>%d</MaxKeys>%s<IsTruncated>%t</IsTruncated>%s</ListBucketResult>`,
			respond.EscapeXML(bucketName), respond.EscapeXML(prefix), maxKeys, pageMeta.String(), isTruncated, contents.String()))
		return
	}

	bucket := st.S3.Buckets[bucketName]

	// ── Multipart upload (object-level: ?uploads / ?uploadId) ─────────────────
	if objectKey != "" && (q.Has("uploads") || q.Has("uploadId")) {
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "No such bucket")
			return
		}
		if bucket.MultipartUploads == nil {
			bucket.MultipartUploads = map[string]*state.MPU{}
		}

		if method == "POST" && q.Has("uploads") { // CreateMultipartUpload
			uploadID := newVersionID()
			ct := r.Header.Get("Content-Type")
			if ct == "" {
				ct = "application/octet-stream"
			}
			bucket.MultipartUploads[uploadID] = &state.MPU{
				UploadID: uploadID, Key: objectKey, ContentType: ct,
				Metadata: extractMetadata(r.Header), Initiated: state.NowMs(), Parts: map[int]*state.MPUPart{},
			}
			respond.XML(w, 200, `<?xml version="1.0"?><InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>`+respond.EscapeXML(bucketName)+`</Bucket><Key>`+respond.EscapeXML(objectKey)+`</Key><UploadId>`+uploadID+`</UploadId></InitiateMultipartUploadResult>`)
			return
		}

		uploadID := q.Get("uploadId")
		mpu := bucket.MultipartUploads[uploadID]
		if mpu == nil {
			s3Error(w, 404, "NoSuchUpload", "The specified multipart upload does not exist.")
			return
		}

		if method == "PUT" && q.Has("partNumber") { // UploadPart
			partNumber, _ := strconv.Atoi(q.Get("partNumber"))
			sum := md5.Sum(r.RawBody)
			etag := hex.EncodeToString(sum[:])
			if err := s.writeMpuPart(bucketName, uploadID, partNumber, r.RawBody); err != nil {
				s3Error(w, 500, "InternalError", "Failed to persist part: "+err.Error())
				return
			}
			mpu.Parts[partNumber] = &state.MPUPart{PartNumber: partNumber, ETag: etag, Size: int64(len(r.RawBody))}
			w.Header().Set("ETag", `"`+etag+`"`)
			w.WriteHeader(200)
			return
		}

		if method == "GET" { // ListParts
			nums := make([]int, 0, len(mpu.Parts))
			for n := range mpu.Parts {
				nums = append(nums, n)
			}
			sort.Ints(nums)
			var sb strings.Builder
			for _, n := range nums {
				p := mpu.Parts[n]
				sb.WriteString(fmt.Sprintf(`<Part><PartNumber>%d</PartNumber><ETag>&quot;%s&quot;</ETag><Size>%d</Size></Part>`, p.PartNumber, p.ETag, p.Size))
			}
			respond.XML(w, 200, `<?xml version="1.0"?><ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>`+respond.EscapeXML(bucketName)+`</Bucket><Key>`+respond.EscapeXML(objectKey)+`</Key><UploadId>`+uploadID+`</UploadId>`+sb.String()+`</ListPartsResult>`)
			return
		}

		if method == "DELETE" { // AbortMultipartUpload
			delete(bucket.MultipartUploads, uploadID)
			_ = os.RemoveAll(s.mpuDir(bucketName, uploadID))
			w.WriteHeader(204)
			return
		}

		if method == "POST" { // CompleteMultipartUpload
			var order []int
			for _, m := range regexp.MustCompile(`<PartNumber>(\d+)</PartNumber>`).FindAllStringSubmatch(string(r.RawBody), -1) {
				n, _ := strconv.Atoi(m[1])
				order = append(order, n)
			}
			if len(order) == 0 {
				for n := range mpu.Parts {
					order = append(order, n)
				}
				sort.Ints(order)
			}
			var full []byte
			var md5cat []byte
			for _, pn := range order {
				part := mpu.Parts[pn]
				if part == nil {
					s3Error(w, 400, "InvalidPart", fmt.Sprintf("Part %d not found", pn))
					return
				}
				data, err := os.ReadFile(filepath.Join(s.mpuDir(bucketName, uploadID), strconv.Itoa(pn)))
				if err != nil {
					s3Error(w, 400, "InvalidPart", fmt.Sprintf("Part %d data missing", pn))
					return
				}
				full = append(full, data...)
				raw, _ := hex.DecodeString(part.ETag)
				md5cat = append(md5cat, raw...)
			}
			// S3 multipart ETag = md5(concatenated binary part-MD5s) + "-<count>".
			catSum := md5.Sum(md5cat)
			etag := hex.EncodeToString(catSum[:]) + "-" + strconv.Itoa(len(order))
			versioned := bucket.Versioning == "Enabled"
			var versionID *string
			if versioned {
				v := newVersionID()
				versionID = &v
			}
			if err := s.writeObject(bucketName, objectKey, full); err != nil {
				s3Error(w, 500, "InternalError", "Failed to assemble object: "+err.Error())
				return
			}
			if versioned {
				_ = s.writeVersion(bucketName, objectKey, *versionID, full)
			}
			meta := &state.ObjectMeta{
				Key: objectKey, Size: int64(len(full)), ContentType: mpu.ContentType, ETag: etag,
				Modified: state.NowMs(), Metadata: orEmpty(mpu.Metadata), VersionID: versionID,
			}
			bucket.Objects[objectKey] = meta
			if versioned {
				bucket.ObjectVersions[objectKey] = append([]*state.ObjectMeta{meta}, bucket.ObjectVersions[objectKey]...)
			}
			delete(bucket.MultipartUploads, uploadID)
			_ = os.RemoveAll(s.mpuDir(bucketName, uploadID))
			after = append(after, s.emitS3Event(st, bucketName, objectKey, "s3:ObjectCreated:CompleteMultipartUpload", meta)...)
			if versioned {
				w.Header().Set("x-amz-version-id", *versionID)
			}
			respond.XML(w, 200, `<?xml version="1.0"?><CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>http://localhost:4566/`+respond.EscapeXML(bucketName)+`/`+respond.EscapeXML(objectKey)+`</Location><Bucket>`+respond.EscapeXML(bucketName)+`</Bucket><Key>`+respond.EscapeXML(objectKey)+`</Key><ETag>&quot;`+etag+`&quot;</ETag></CompleteMultipartUploadResult>`)
			return
		}
	}

	// ── Head object ───────────────────────────────────────────────────────────
	if method == "HEAD" && objectKey != "" {
		if bucket == nil {
			w.WriteHeader(404)
			return
		}
		versionID := q.Get("versionId")
		var obj *state.ObjectMeta
		if versionID != "" {
			obj = findVersion(bucket, objectKey, versionID)
			if obj == nil || obj.IsDeleteMarker {
				w.WriteHeader(404)
				return
			}
		} else {
			obj = bucket.Objects[objectKey]
			if obj == nil {
				w.WriteHeader(404)
				return
			}
			if obj.IsDeleteMarker {
				w.Header().Set("x-amz-delete-marker", "true")
				if obj.VersionID != nil {
					w.Header().Set("x-amz-version-id", *obj.VersionID)
				}
				w.WriteHeader(404)
				return
			}
		}
		w.Header().Set("Content-Length", strconv.FormatInt(obj.Size, 10))
		w.Header().Set("Content-Type", obj.ContentType)
		w.Header().Set("ETag", `"`+obj.ETag+`"`)
		w.Header().Set("Last-Modified", httpDate(obj.Modified))
		for k, v := range obj.Metadata {
			w.Header().Set("x-amz-meta-"+k, v)
		}
		if obj.VersionID != nil {
			w.Header().Set("x-amz-version-id", *obj.VersionID)
		}
		w.WriteHeader(200)
		return
	}

	// ── Get object ────────────────────────────────────────────────────────────
	if method == "GET" && objectKey != "" {
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "No such bucket")
			return
		}
		versionID := q.Get("versionId")
		var obj *state.ObjectMeta
		readVersionID := ""
		if versionID != "" {
			obj = findVersion(bucket, objectKey, versionID)
			if obj == nil {
				s3Error(w, 404, "NoSuchVersion", "The specified version does not exist.")
				return
			}
			if obj.IsDeleteMarker {
				s3Error(w, 404, "NoSuchKey", "The specified key does not exist.")
				return
			}
			readVersionID = versionID
		} else {
			obj = bucket.Objects[objectKey]
			if obj == nil {
				s3Error(w, 404, "NoSuchKey", "The specified key does not exist.")
				return
			}
			if obj.IsDeleteMarker {
				w.Header().Set("x-amz-delete-marker", "true")
				if obj.VersionID != nil {
					w.Header().Set("x-amz-version-id", *obj.VersionID)
				}
				s3Error(w, 404, "NoSuchKey", "The specified key does not exist.")
				return
			}
		}
		switch checkConditional(r, obj) {
		case 412:
			s3Error(w, 412, "PreconditionFailed", "At least one of the preconditions you specified did not hold.")
			return
		case 304:
			w.Header().Set("ETag", `"`+obj.ETag+`"`)
			w.WriteHeader(304)
			return
		}

		var buf []byte
		var err error
		if readVersionID != "" {
			buf, err = os.ReadFile(s.versionDiskPath(bucketName, objectKey, readVersionID))
		} else {
			var p string
			if p, err = s.diskPath(bucketName, objectKey); err == nil {
				buf, err = os.ReadFile(p)
			}
		}
		if err != nil {
			s3Error(w, 500, "InternalError", "Failed to read object body")
			return
		}
		ct := obj.ContentType
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("ETag", `"`+obj.ETag+`"`)
		w.Header().Set("Last-Modified", httpDate(obj.Modified))
		w.Header().Set("Accept-Ranges", "bytes")
		for k, v := range obj.Metadata {
			w.Header().Set("x-amz-meta-"+k, v)
		}
		if obj.VersionID != nil {
			w.Header().Set("x-amz-version-id", *obj.VersionID)
		}

		start, end, kind := parseRange(r.Header.Get("Range"), int64(len(buf)))
		switch kind {
		case rangeInvalid:
			w.Header().Set("Content-Range", "bytes */"+strconv.Itoa(len(buf)))
			w.WriteHeader(416)
			return
		case rangeOK:
			slice := buf[start : end+1]
			w.Header().Set("Content-Length", strconv.Itoa(len(slice)))
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(buf)))
			w.WriteHeader(206)
			_, _ = w.Write(slice)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(buf)))
		w.WriteHeader(200)
		_, _ = w.Write(buf)
		return
	}

	// ── Put object (incl. CopyObject) ────────────────────────────────────────
	if method == "PUT" && objectKey != "" {
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "No such bucket")
			return
		}

		if copySource := r.Header.Get("x-amz-copy-source"); copySource != "" {
			decoded, err := url.PathUnescape(strings.TrimPrefix(copySource, "/"))
			if err != nil {
				decoded = strings.TrimPrefix(copySource, "/")
			}
			decoded = strings.SplitN(decoded, "?", 2)[0]
			slash := strings.Index(decoded, "/")
			if slash < 0 {
				s3Error(w, 404, "NoSuchKey", "The specified copy source does not exist.")
				return
			}
			srcBucketName, srcKey := decoded[:slash], decoded[slash+1:]
			var src *state.ObjectMeta
			if sb := st.S3.Buckets[srcBucketName]; sb != nil {
				src = sb.Objects[srcKey]
			}
			if src == nil || src.IsDeleteMarker {
				s3Error(w, 404, "NoSuchKey", "The specified copy source does not exist.")
				return
			}
			srcPath, err := s.diskPath(srcBucketName, srcKey)
			var body []byte
			if err == nil {
				body, err = os.ReadFile(srcPath)
			}
			if err != nil {
				s3Error(w, 500, "InternalError", "Failed to read copy source")
				return
			}
			sum := md5.Sum(body)
			cetag := hex.EncodeToString(sum[:])
			versioned := bucket.Versioning == "Enabled"
			var versionID *string
			if versioned {
				v := newVersionID()
				versionID = &v
			}
			if err := s.writeObject(bucketName, objectKey, body); err != nil {
				s3Error(w, 500, "InternalError", "Failed to persist copy: "+err.Error())
				return
			}
			if versioned {
				_ = s.writeVersion(bucketName, objectKey, *versionID, body)
			}
			replace := strings.ToUpper(headerOr(r, "x-amz-metadata-directive", "COPY")) == "REPLACE"
			meta := &state.ObjectMeta{
				Key: objectKey, Size: int64(len(body)),
				ContentType: headerOr(r, "Content-Type", src.ContentType),
				ETag:        cetag, Modified: state.NowMs(), VersionID: versionID,
			}
			if replace {
				meta.Metadata = extractMetadata(r.Header)
			} else {
				meta.Metadata = orEmpty(src.Metadata)
			}
			bucket.Objects[objectKey] = meta
			if versioned {
				bucket.ObjectVersions[objectKey] = append([]*state.ObjectMeta{meta}, bucket.ObjectVersions[objectKey]...)
			}
			after = append(after, s.emitS3Event(st, bucketName, objectKey, "s3:ObjectCreated:Copy", meta)...)
			if versioned {
				w.Header().Set("x-amz-version-id", *versionID)
			}
			respond.XML(w, 200, `<?xml version="1.0"?><CopyObjectResult><ETag>&quot;`+cetag+`&quot;</ETag><LastModified>`+iso(meta.Modified)+`</LastModified></CopyObjectResult>`)
			return
		}

		buf := r.RawBody
		sum := md5.Sum(buf)
		etag := hex.EncodeToString(sum[:])
		versioned := bucket.Versioning == "Enabled"
		var versionID *string
		if versioned {
			v := newVersionID()
			versionID = &v
		}
		if err := s.writeObject(bucketName, objectKey, buf); err != nil {
			s3Error(w, 500, "InternalError", "Failed to persist object: "+err.Error())
			return
		}
		if versioned {
			_ = s.writeVersion(bucketName, objectKey, *versionID, buf)
		}
		meta := &state.ObjectMeta{
			Key: objectKey, Size: int64(len(buf)),
			ContentType: headerOr(r, "Content-Type", "application/octet-stream"),
			ETag:        etag, Modified: state.NowMs(),
			Metadata: extractMetadata(r.Header), VersionID: versionID,
		}
		bucket.Objects[objectKey] = meta
		if versioned {
			bucket.ObjectVersions[objectKey] = append([]*state.ObjectMeta{meta}, bucket.ObjectVersions[objectKey]...)
		}
		st.AddTrail(map[string]any{"method": "PUT", "path": "/s3/" + bucketName + "/" + objectKey, "status": 200, "latency": 2})
		after = append(after, s.emitS3Event(st, bucketName, objectKey, "s3:ObjectCreated:Put", meta)...)
		w.Header().Set("ETag", `"`+etag+`"`)
		if versioned {
			w.Header().Set("x-amz-version-id", *versionID)
		}
		w.WriteHeader(200)
		return
	}

	// ── Delete object ──────────────────────────────────────────────────────────
	if method == "DELETE" && objectKey != "" {
		if bucket == nil {
			s3Error(w, 404, "NoSuchBucket", "No such bucket")
			return
		}
		versionID := q.Get("versionId")
		history := bucket.ObjectVersions[objectKey]

		// Permanently remove one specific version.
		if versionID != "" {
			if history != nil {
				idx := -1
				for i, v := range history {
					if deref(v.VersionID) == versionID {
						idx = i
						break
					}
				}
				if idx != -1 {
					removed := history[idx]
					history = append(history[:idx], history[idx+1:]...)
					bucket.ObjectVersions[objectKey] = history
					_ = os.Remove(s.versionDiskPath(bucketName, objectKey, versionID))
					if len(history) == 0 {
						delete(bucket.ObjectVersions, objectKey)
						delete(bucket.Objects, objectKey)
						if p, err := s.diskPath(bucketName, objectKey); err == nil {
							_ = os.Remove(p)
						}
					} else if idx == 0 {
						// Deleted the head — promote the next version to current.
						head := history[0]
						bucket.Objects[objectKey] = head
						if !head.IsDeleteMarker {
							if data, err := os.ReadFile(s.versionDiskPath(bucketName, objectKey, deref(head.VersionID))); err == nil {
								_ = s.writeObject(bucketName, objectKey, data)
							}
						}
					}
					w.Header().Set("x-amz-version-id", versionID)
					if removed.IsDeleteMarker {
						w.Header().Set("x-amz-delete-marker", "true")
					}
					w.WriteHeader(204)
					return
				}
			}
			w.Header().Set("x-amz-version-id", versionID)
			w.WriteHeader(204)
			return
		}

		// Versioning enabled: plain DELETE inserts a delete marker.
		if bucket.Versioning == "Enabled" {
			vid := newVersionID()
			marker := &state.ObjectMeta{Key: objectKey, IsDeleteMarker: true, VersionID: &vid, Modified: state.NowMs()}
			bucket.ObjectVersions[objectKey] = append([]*state.ObjectMeta{marker}, bucket.ObjectVersions[objectKey]...)
			bucket.Objects[objectKey] = marker
			st.AddTrail(map[string]any{"method": "DELETE", "path": "/s3/" + bucketName + "/" + objectKey, "status": 204, "latency": 1})
			after = append(after, s.emitS3Event(st, bucketName, objectKey, "s3:ObjectRemoved:DeleteMarkerCreated", marker)...)
			w.Header().Set("x-amz-version-id", vid)
			w.Header().Set("x-amz-delete-marker", "true")
			w.WriteHeader(204)
			return
		}

		// Unversioned delete.
		delete(bucket.Objects, objectKey)
		if p, err := s.diskPath(bucketName, objectKey); err == nil {
			_ = os.Remove(p)
		}
		st.AddTrail(map[string]any{"method": "DELETE", "path": "/s3/" + bucketName + "/" + objectKey, "status": 204, "latency": 1})
		after = append(after, s.emitS3Event(st, bucketName, objectKey, "s3:ObjectRemoved:Delete", &state.ObjectMeta{Key: objectKey})...)
		w.WriteHeader(204)
		return
	}

	s3Error(w, 400, "InvalidRequest", "Unknown S3 operation")
	return
}
