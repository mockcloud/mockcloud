package lambda

import (
	"bytes"
	"compress/flate"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mockcloud/mockcloud/internal/state"
)

// Node discovery: Node's runInNodeSandbox used process.execPath (itself);
// the Go daemon has no embedded Node, so: MOCKCLOUD_NODE_BIN override, else
// one PATH lookup at first use, cached. The child env never contains PATH
// (denylist), so per-invoke PATH influence is impossible either way.
var nodeBin = sync.OnceValues(func() (string, error) {
	if p := os.Getenv("MOCKCLOUD_NODE_BIN"); p != "" {
		return p, nil
	}
	return exec.LookPath("node")
})

// ── Zip extraction ───────────────────────────────────────────────────────────
// Direct port of Node's hand-rolled parser — NOT archive/zip: extraction
// FAILURE triggers the raw-source fallback (the path most tests use), and the
// two implementations accept/reject different malformed inputs. Handles
// single-file zips with stored (0) or DEFLATE (8) compression; picks
// index.{js,mjs,cjs} at the shallowest depth.

var indexRe = regexp.MustCompile(`(^|/)index\.(js|mjs|cjs)$`)

func extractZip(buf []byte) (string, bool) {
	defer func() { recover() }() // any parse panic → ("", false), like Node's catch
	u32 := func(off int) (uint32, bool) {
		if off < 0 || off+4 > len(buf) {
			return 0, false
		}
		return binary.LittleEndian.Uint32(buf[off:]), true
	}
	u16 := func(off int) (uint16, bool) {
		if off < 0 || off+2 > len(buf) {
			return 0, false
		}
		return binary.LittleEndian.Uint16(buf[off:]), true
	}

	// End-of-central-directory scan, back from the tail.
	eocd := -1
	low := len(buf) - 65557
	if low < 0 {
		low = 0
	}
	for i := len(buf) - 22; i >= low; i-- {
		if sig, ok := u32(i); ok && sig == 0x06054b50 {
			eocd = i
			break
		}
	}
	if eocd < 0 {
		return "", false
	}
	cdEntries, ok1 := u16(eocd + 10)
	cdSize, ok2 := u32(eocd + 12)
	cdOffset, ok3 := u32(eocd + 16)
	if !ok1 || !ok2 || !ok3 {
		return "", false
	}

	type entry struct {
		name        string
		method      uint16
		compSize    uint32
		uncompSize  uint32
		localOffset uint32
		depth       int
		order       int
	}
	var candidates []entry
	p := int(cdOffset)
	end := int(cdOffset) + int(cdSize)
	for n := 0; n < int(cdEntries) && p < end; n++ {
		sig, ok := u32(p)
		if !ok || sig != 0x02014b50 {
			break
		}
		method, _ := u16(p + 10)
		compSize, _ := u32(p + 20)
		uncompSize, _ := u32(p + 24)
		nameLen, _ := u16(p + 28)
		extraLen, _ := u16(p + 30)
		commentLen, _ := u16(p + 32)
		localOffset, _ := u32(p + 42)
		if p+46+int(nameLen) > len(buf) {
			return "", false
		}
		name := string(buf[p+46 : p+46+int(nameLen)])
		candidates = append(candidates, entry{
			name: name, method: method, compSize: compSize, uncompSize: uncompSize,
			localOffset: localOffset, depth: strings.Count(name, "/"), order: n,
		})
		p += 46 + int(nameLen) + int(extraLen) + int(commentLen)
	}

	var matches []entry
	for _, e := range candidates {
		if indexRe.MatchString(e.name) {
			matches = append(matches, e)
		}
	}
	if len(matches) == 0 {
		return "", false
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[i].depth < matches[j].depth })
	target := matches[0]

	// Size-claim bomb check before allocating.
	if int(target.uncompSize) > codeSizeCap {
		return "", false
	}

	lh := int(target.localOffset)
	sig, ok := u32(lh)
	if !ok || sig != 0x04034b50 {
		return "", false
	}
	lhNameLen, _ := u16(lh + 26)
	lhExtraLen, _ := u16(lh + 28)
	dataStart := lh + 30 + int(lhNameLen) + int(lhExtraLen)
	dataEnd := dataStart + int(target.compSize)
	if dataStart > len(buf) || dataEnd > len(buf) || dataStart > dataEnd {
		return "", false
	}
	compressed := buf[dataStart:dataEnd]

	switch target.method {
	case 0: // stored — Node SLICES to the cap (no error); DEFLATE errors instead.
		raw := compressed
		if len(raw) > codeSizeCap {
			raw = raw[:codeSizeCap]
		}
		return string(raw), true
	case 8: // DEFLATE with the maxOutputLength equivalent: exceeding the cap fails.
		fr := flate.NewReader(bytes.NewReader(compressed))
		raw, err := io.ReadAll(io.LimitReader(fr, int64(codeSizeCap)+1))
		if err != nil || len(raw) > codeSizeCap {
			return "", false
		}
		return string(raw), true
	}
	return "", false
}

// ── Child environment (buildChildEnv + lambdaEnv) ───────────────────────────
// The child gets a minimal OS base plus the function's own env AFTER the
// runtime-hook denylist — never the daemon's full environment.

var envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var envKeyDeny = regexp.MustCompile(`(?i)^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|PATH|PATHEXT|SYSTEMROOT|COMSPEC)$`)

func lambdaEnv(fn sandboxSpec) []string {
	env := map[string]string{}
	var base []string
	if os.PathSeparator == '\\' { // win32
		base = []string{"SystemRoot", "TEMP", "TMP", "USERPROFILE"}
	} else {
		base = []string{"HOME", "TMPDIR"}
	}
	for _, k := range base {
		if v := os.Getenv(k); v != "" {
			env[k] = v
		}
	}
	for k, v := range fn.env {
		if !envKeyRe.MatchString(k) || envKeyDeny.MatchString(k) || strings.ContainsRune(v, 0) {
			continue
		}
		env[k] = v
	}
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "us-east-1"
	}
	defRegion := os.Getenv("AWS_DEFAULT_REGION")
	if defRegion == "" {
		defRegion = "us-east-1"
	}
	runtime := fn.runtime
	if runtime == "" {
		runtime = "nodejs"
	}
	handler := fn.handler
	if handler == "" {
		handler = "index.handler"
	}
	memory := fn.memory
	if memory == 0 {
		memory = 128
	}
	env["AWS_REGION"] = region
	env["AWS_DEFAULT_REGION"] = defRegion
	env["AWS_LAMBDA_FUNCTION_NAME"] = fn.name
	env["AWS_LAMBDA_FUNCTION_VERSION"] = "$LATEST"
	env["AWS_LAMBDA_FUNCTION_MEMORY_SIZE"] = strconv.Itoa(int(memory))
	env["AWS_EXECUTION_ENV"] = "AWS_Lambda_" + runtime
	env["_HANDLER"] = handler

	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

// ── Sandbox execution ────────────────────────────────────────────────────────

type sandboxSpec struct {
	name    string
	code    string
	handler string
	runtime string
	timeout float64
	memory  float64
	env     map[string]string
}

// runInNodeSandbox — one-shot child process, same contract as Node:
// runner.js template byte-identical (its stderr surfaces in assertions),
// event via argv[2], result on stdout, error text = stderr-or-err.
func runInNodeSandbox(fn sandboxSpec, payload string) (string, error) {
	node, err := nodeBin()
	if err != nil {
		return "", errors.New("MockCloud: Node.js runtime not found on PATH (set MOCKCLOUD_NODE_BIN); cannot execute nodejs function " + fn.name)
	}
	tmpDir := filepath.Join(os.TempDir(), "mockcloud-lambda-"+state.RandomID(8))
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return "", err
	}
	defer os.RemoveAll(tmpDir)
	if err := os.WriteFile(filepath.Join(tmpDir, "index.js"), []byte(fn.code), 0o644); err != nil {
		return "", err
	}
	handlerName := fn.handler
	if handlerName == "" {
		handlerName = "index.handler"
	}
	parts := strings.Split(handlerName, ".")
	last := parts[len(parts)-1]
	runner := `
const mod = require('./index');
const handlerName = ` + strconv.Quote(last) + `;
const handler = mod[handlerName] || mod.handler || mod.default;
if (typeof handler !== 'function') {
  process.stderr.write('Handler "' + handlerName + '" not found in module.exports');
  process.exit(1);
}
const event = JSON.parse(process.argv[2] || '{}');
Promise.resolve(handler(event, {})).then(r => {
  process.stdout.write(JSON.stringify(r === undefined ? null : r));
}).catch(e => {
  process.stderr.write(e && e.message ? e.message : String(e));
  process.exit(1);
});
`
	if err := os.WriteFile(filepath.Join(tmpDir, "runner.js"), []byte(runner), 0o644); err != nil {
		return "", err
	}
	timeoutMs := int64(fn.timeout * 1000)
	if timeoutMs < 1000 {
		timeoutMs = 1000
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, "runner.js", payload)
	cmd.Dir = tmpDir
	cmd.Env = lambdaEnv(fn)
	cmd.WaitDelay = 2 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			if ctx.Err() == context.DeadlineExceeded {
				msg = "Task timed out after " + strconv.FormatFloat(float64(timeoutMs)/1000, 'f', -1, 64) + " seconds"
			} else {
				msg = err.Error()
			}
		}
		return "", errors.New(msg)
	}
	out := stdout.String()
	if out == "" {
		out = "null"
	}
	return out, nil
}
