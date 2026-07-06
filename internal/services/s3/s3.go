// Package s3 — port of src/services/s3.js.
//
// M1 scope: ListBuckets + CreateBucket (+ the OPTIONS fall-through and
// virtual-host parsing skeleton). The object data plane, multipart,
// presigned URLs, versioning and notifications land in M3.
package s3

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/mockcloud/mockcloud/internal/config"
	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

// AWS bucket-naming rules — the primary defense against names like '../..'
// escaping S3_ROOT when joined (BUCKET_NAME_RE in s3.js).
var bucketNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

// Virtual-hosted-style addressing (parseS3Host).
var s3HostRe = regexp.MustCompile(`^(.+?)\.s3(?:[.-][a-z0-9-]+)?\.(amazonaws\.com|localhost\.localstack\.cloud)$`)

// Sub-resource query params that make a key-less PUT NOT a CreateBucket.
var subResources = []string{
	"website", "acl", "publicAccessBlock", "versioning", "policy", "cors",
	"tagging", "logging", "versions", "notification", "uploads",
}

type Service struct {
	st  *store.Store
	cfg *config.Config
}

func New(st *store.Store, cfg *config.Config) *Service { return &Service{st: st, cfg: cfg} }

func parseS3Host(host string) string {
	host = strings.ToLower(strings.Split(host, ":")[0])
	m := s3HostRe.FindStringSubmatch(host)
	if m == nil {
		return ""
	}
	return m[1]
}

// s3Error — S3's <Error> document (not the query-protocol <ErrorResponse>).
func s3Error(w http.ResponseWriter, status int, code, message string) {
	respond.XML(w, status,
		`<?xml version="1.0"?><Error><Code>`+code+`</Code><Message>`+
			respond.EscapeXML(message)+`</Message></Error>`)
}

func (s *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	hostBucket := parseS3Host(r.Host)
	rawPath := strings.TrimPrefix(r.URL.EscapedPath(), "/")
	var pathParts []string
	for _, p := range strings.Split(rawPath, "/") {
		if p != "" {
			pathParts = append(pathParts, p)
		}
	}
	if hostBucket != "" {
		pathParts = append([]string{hostBucket}, pathParts...)
	}

	// ── List all buckets ────────────────────────────────────────────────
	if r.Method == "GET" && r.URL.EscapedPath() == "/" && hostBucket == "" {
		var entries []string
		s.st.With(func(st *state.State) {
			for _, b := range st.S3.Buckets {
				entries = append(entries,
					"<Bucket><Name>"+respond.EscapeXML(b.Name)+"</Name><CreationDate>"+
						state.ISO(b.Created)+"</CreationDate></Bucket>")
			}
		})
		sort.Strings(entries)
		respond.XML(w, 200,
			`<?xml version="1.0"?><ListAllMyBucketsResult><Buckets>`+
				strings.Join(entries, "")+`</Buckets></ListAllMyBucketsResult>`)
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

	// OPTIONS preflight (bucket CORS rules land in M3; permissive default).
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}

	// ── Create bucket ───────────────────────────────────────────────────
	hasSubResource := false
	for _, sr := range subResources {
		if r.Query.Has(sr) {
			hasSubResource = true
			break
		}
	}
	if r.Method == "PUT" && objectKey == "" && !hasSubResource {
		if !bucketNameRe.MatchString(bucketName) {
			s3Error(w, 400, "InvalidBucketName", "Bucket name does not match AWS naming rules")
			return
		}
		var exists bool
		s.st.With(func(st *state.State) {
			if st.S3.Buckets[bucketName] != nil {
				exists = true
				return
			}
			region := r.Header.Get("x-amz-bucket-region")
			if region == "" {
				region = "us-east-1"
			}
			st.S3.Buckets[bucketName] = &state.Bucket{
				Name: bucketName, Region: region, Created: state.NowMs(),
				Objects:        map[string]map[string]any{},
				ObjectVersions: map[string]any{}, MultipartUploads: map[string]any{},
				Website: nil, ACL: "private",
				PublicAccessBlock: state.PublicAccessBlock{
					BlockPublicAcls: true, IgnorePublicAcls: true,
					BlockPublicPolicy: true, RestrictPublicBuckets: true,
				},
				Versioning: "Suspended",
			}
			st.AddTrail(map[string]any{"method": "PUT", "path": "/s3/" + bucketName, "status": 200, "latency": 2})
		})
		if exists {
			s3Error(w, 409, "BucketAlreadyOwnedByYou", "Bucket "+bucketName+" already exists")
			return
		}
		_ = os.MkdirAll(filepath.Join(s.cfg.S3Root, bucketName), 0o755)
		w.Header().Set("Location", "/"+bucketName)
		respond.XML(w, 200, "")
		return
	}

	// Everything else (object data plane, sub-resources, listings) — M3.
	s3Error(w, 501, "NotImplemented", "MockCloud Go port: S3 operation not yet ported (M3)")
}
