// /mockcloud/s3/* UI routes — port of src/routes/s3.js.
//
// Object operations use ?key=<encodedKey> in the query string rather than
// :key in the path, because S3 keys can contain slashes and the router's
// :param syntax can't capture across `/`. The disk helpers mirror the s3
// service's unexported ones ('..' key segments → '__', containment under
// S3_ROOT, tmp-file + rename writes).
package controlplane

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
)

// AWS bucket-naming rules: 3–63 chars, lowercase alphanumerics, dots and
// hyphens, must start and end with alphanumeric. This is the primary defense
// against bucket names like '../..' that would escape S3_ROOT when joined;
// safeJoinS3 below is the belt-and-braces backup.
var bucketNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

func RegisterS3UIRoutes(rt *Router, d Deps) {

	rt.Get("/mockcloud/s3/buckets", func(w http.ResponseWriter, r *httpapi.Request) {
		buckets := []any{}
		d.Store.With(func(st *state.State) {
			names := make([]string, 0, len(st.S3.Buckets))
			for n := range st.S3.Buckets {
				names = append(names, n)
			}
			sort.Strings(names)
			for _, n := range names {
				b := st.S3.Buckets[n]
				var totalSize int64
				for _, o := range b.Objects {
					totalSize += o.Size
				}
				buckets = append(buckets, map[string]any{
					"name":        b.Name,
					"region":      b.Region,
					"created":     b.Created,
					"objectCount": len(b.Objects),
					"totalSize":   totalSize,
				})
			}
		})
		respond.JSON(w, 200, map[string]any{"buckets": buckets})
	})

	rt.Post("/mockcloud/s3/buckets", func(w http.ResponseWriter, r *httpapi.Request) {
		name := httpapi.Str(r.ParsedBody, "name")
		if !jsnum.Truthy(r.ParsedBody["name"]) {
			respond.ErrorJSON(w, 400, "ValidationError", "name required")
			return
		}
		// Node's isValidBucketName also rejects non-strings.
		if _, isStr := r.ParsedBody["name"].(string); !isStr || !bucketNameRe.MatchString(name) {
			respond.ErrorJSON(w, 400, "ValidationError", "bucket name must match AWS naming rules (3-63 chars, lowercase alphanumeric, dots, hyphens)")
			return
		}
		region := httpapi.Str(r.ParsedBody, "region")
		if region == "" {
			region = "us-east-1"
		}
		var exists bool
		var bucket *state.Bucket
		d.Store.With(func(st *state.State) {
			if st.S3.Buckets[name] != nil {
				exists = true
				return
			}
			// Node's UI bucket carries only {name, region, created, objects};
			// the empty sibling maps keep the AWS-side handlers nil-safe.
			bucket = &state.Bucket{
				Name: name, Region: region, Created: state.NowMs(),
				Objects:        map[string]*state.ObjectMeta{},
				ObjectVersions: map[string][]*state.ObjectMeta{}, MultipartUploads: map[string]*state.MPU{},
			}
			st.S3.Buckets[name] = bucket
			st.AddTrail(map[string]any{"method": "POST", "path": "/s3/" + name, "status": 200, "latency": 2})
		})
		if exists {
			respond.ErrorJSON(w, 409, "Conflict", "Bucket already exists")
			return
		}
		respond.JSON(w, 201, bucket)
	})

	rt.Delete("/mockcloud/s3/buckets/:name", func(w http.ResponseWriter, r *httpapi.Request) {
		name := r.Params["name"]
		status := 0
		d.Store.With(func(st *state.State) {
			b := st.S3.Buckets[name]
			if b == nil {
				status = 404
				return
			}
			if len(b.Objects) > 0 {
				status = 409
				return
			}
			delete(st.S3.Buckets, name)
			st.AddTrail(map[string]any{"method": "DELETE", "path": "/s3/" + name, "status": 200, "latency": 1})
		})
		switch status {
		case 404:
			respond.ErrorJSON(w, 404, "NotFound", "Bucket not found")
		case 409:
			respond.ErrorJSON(w, 409, "Conflict", "Bucket not empty")
		default:
			respond.JSON(w, 200, map[string]any{"deleted": name})
		}
	})

	rt.Get("/mockcloud/s3/buckets/:name/objects", func(w http.ResponseWriter, r *httpapi.Request) {
		name := r.Params["name"]
		var found bool
		objects := []any{}
		d.Store.With(func(st *state.State) {
			b := st.S3.Buckets[name]
			if b == nil {
				return
			}
			found = true
			keys := make([]string, 0, len(b.Objects))
			for k := range b.Objects {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				o := b.Objects[k]
				objects = append(objects, map[string]any{
					"key": o.Key, "size": o.Size, "contentType": o.ContentType,
					"modified": o.Modified, "etag": o.ETag,
				})
			}
		})
		if !found {
			respond.ErrorJSON(w, 404, "NotFound", "Bucket not found")
			return
		}
		respond.JSON(w, 200, map[string]any{"objects": objects, "bucket": name})
	})

	// ── Upload object ────────────────────────────────────────────────────
	// POST /mockcloud/s3/buckets/:name/objects?key=<encodedKey>
	// Body: raw file bytes. Content-Type header preserved.
	rt.Post("/mockcloud/s3/buckets/:name/objects", func(w http.ResponseWriter, r *httpapi.Request) {
		name := r.Params["name"]
		key := r.Query.Get("key")
		if key == "" {
			respond.ErrorJSON(w, 400, "ValidationError", "key query param required")
			return
		}
		var bucketExists bool
		d.Store.With(func(st *state.State) { bucketExists = st.S3.Buckets[name] != nil })
		if !bucketExists {
			respond.ErrorJSON(w, 404, "NotFound", "Bucket not found")
			return
		}
		buf := r.RawBody
		if len(buf) == 0 {
			respond.ErrorJSON(w, 400, "ValidationError", "empty body")
			return
		}
		contentType := r.Header.Get("content-type")
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		// putObjectToBucket: disk write first (outside the lock), then the
		// metadata registration.
		if err := writeS3ObjectToDisk(d.Cfg.S3Root, name, key, buf); err != nil {
			respond.ErrorJSON(w, 500, "UploadFailed", err.Error())
			return
		}
		sum := md5.Sum(buf)
		obj := &state.ObjectMeta{
			Key: key, Size: int64(len(buf)), ContentType: contentType,
			ETag: hex.EncodeToString(sum[:]), Modified: state.NowMs(), Metadata: map[string]string{},
		}
		var gone bool
		d.Store.With(func(st *state.State) {
			b := st.S3.Buckets[name]
			if b == nil {
				gone = true
				return
			}
			b.Objects[key] = obj
			st.AddTrail(map[string]any{"method": "POST", "path": "/s3/" + name + "/" + key, "status": 200, "latency": 2})
		})
		if gone {
			respond.ErrorJSON(w, 500, "UploadFailed", "Bucket "+name+" does not exist")
			return
		}
		respond.JSON(w, 201, map[string]any{"key": obj.Key, "size": obj.Size, "etag": obj.ETag, "contentType": obj.ContentType})
	})

	// ── Download object ──────────────────────────────────────────────────
	// GET /mockcloud/s3/buckets/:name/object?key=<encodedKey>
	rt.Get("/mockcloud/s3/buckets/:name/object", func(w http.ResponseWriter, r *httpapi.Request) {
		name := r.Params["name"]
		key := r.Query.Get("key")
		if key == "" {
			respond.ErrorJSON(w, 400, "ValidationError", "key query param required")
			return
		}
		var obj *state.ObjectMeta
		var found bool
		d.Store.With(func(st *state.State) {
			b := st.S3.Buckets[name]
			if b == nil {
				return
			}
			found = true
			obj = b.Objects[key]
		})
		if !found {
			respond.ErrorJSON(w, 404, "NotFound", "Bucket not found")
			return
		}
		if obj == nil {
			respond.ErrorJSON(w, 404, "NotFound", "Object not found")
			return
		}
		p, err := s3DiskPath(d.Cfg.S3Root, name, key)
		var buf []byte
		if err == nil {
			buf, err = os.ReadFile(p)
		}
		if err != nil {
			respond.ErrorJSON(w, 500, "ReadFailed", "Could not read object body")
			return
		}
		contentType := obj.ContentType
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Length", strconv.Itoa(len(buf)))
		w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(key)+`"`)
		w.Header().Set("ETag", `"`+obj.ETag+`"`)
		w.WriteHeader(200)
		_, _ = w.Write(buf)
	})

	// ── Delete object ────────────────────────────────────────────────────
	// DELETE /mockcloud/s3/buckets/:name/object?key=<encodedKey>
	rt.Delete("/mockcloud/s3/buckets/:name/object", func(w http.ResponseWriter, r *httpapi.Request) {
		name := r.Params["name"]
		key := r.Query.Get("key")
		if key == "" {
			respond.ErrorJSON(w, 400, "ValidationError", "key query param required")
			return
		}
		notFoundMsg := ""
		d.Store.With(func(st *state.State) {
			b := st.S3.Buckets[name]
			if b == nil {
				notFoundMsg = "Bucket not found"
				return
			}
			// Object must be registered via the API before we delete its
			// on-disk file. Without this check, attackers could probe for
			// arbitrary file paths under a bad-named bucket.
			if _, registered := b.Objects[key]; !registered {
				notFoundMsg = "Object not found"
				return
			}
			delete(b.Objects, key)
			st.AddTrail(map[string]any{"method": "DELETE", "path": "/s3/" + name + "/" + key, "status": 200, "latency": 1})
		})
		if notFoundMsg != "" {
			respond.ErrorJSON(w, 404, "NotFound", notFoundMsg)
			return
		}
		if p, err := s3DiskPath(d.Cfg.S3Root, name, key); err == nil {
			_ = os.Remove(p) // rmSync({force:true}) — ENOENT silenced
		}
		respond.JSON(w, 200, map[string]any{"deleted": key})
	})
}

// s3DiskPath — diskPath (src/routes/s3.js): '..' key segments become '__',
// then safeJoin containment under S3_ROOT.
func s3DiskPath(root, bucket, key string) (string, error) {
	parts := strings.Split(key, "/")
	for i, p := range parts {
		if p == ".." {
			parts[i] = "__"
		}
	}
	return safeJoinS3(root, bucket, strings.Join(parts, "/"))
}

// safeJoinS3 — safeJoin (src/middleware/http.js): the resolved path must stay
// inside root.
func safeJoinS3(root string, parts ...string) (string, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	target := filepath.Join(append([]string{absRoot}, mapFromSlash(parts)...)...)
	if target == absRoot {
		return target, nil
	}
	rel, err := filepath.Rel(absRoot, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", errors.New("path escape")
	}
	return target, nil
}

func mapFromSlash(parts []string) []string {
	out := make([]string, len(parts))
	for i, p := range parts {
		out[i] = filepath.FromSlash(p)
	}
	return out
}

// writeS3ObjectToDisk — writeObjectToDisk (src/services/s3.js): tmp-file +
// rename with a plain-write fallback.
func writeS3ObjectToDisk(root, bucket, key string, buf []byte) error {
	target, err := s3DiskPath(root, bucket, key)
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
		if werr := os.WriteFile(target, buf, 0o644); werr != nil {
			return werr
		}
		_ = os.Remove(tmp)
	}
	return nil
}
