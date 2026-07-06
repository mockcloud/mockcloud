// marshal.go — the DynamoDB wire<->storage value model, a 1:1 port of the
// marshal/unmarshal helpers in src/services/dynamodb.js (~lines 846-870) plus
// the small JS-semantics utilities the handlers lean on.
//
// Storage is the plain any-tree (nil|string|float64|bool|[]any|map[string]any)
// exactly like Node's unmarshalled JS objects. JS `undefined` is modelled as
// jsnum.Undef so "missing" and JSON null stay distinct.
package dynamodb

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/mockcloud/mockcloud/internal/jsnum"
)

// jsify converts a freshly json.Decoded (UseNumber) tree into Node's
// JSON.parse shape: every number becomes float64. Mutates in place.
func jsify(v any) any {
	switch t := v.(type) {
	case json.Number:
		f, err := t.Float64()
		if err != nil && !strings.Contains(err.Error(), "out of range") {
			return math.NaN()
		}
		return f
	case map[string]any:
		for k, vv := range t {
			t[k] = jsify(vv)
		}
		return t
	case []any:
		for i := range t {
			t[i] = jsify(t[i])
		}
		return t
	}
	return v
}

func jsifyMap(m map[string]any) map[string]any {
	jsify(m)
	return m
}

// marshal is Node's marshal(): JS value → DynamoDB descriptor. The absence of
// SS/NS/BS branches is deliberate — sets degrade to lists (load-bearing quirk).
func marshal(v any) map[string]any {
	if v == nil || jsnum.IsUndef(v) {
		return map[string]any{"NULL": true}
	}
	switch t := v.(type) {
	case bool:
		return map[string]any{"BOOL": t}
	case float64:
		return map[string]any{"N": jsnum.Format(t)}
	case string:
		return map[string]any{"S": t}
	case []any:
		l := make([]any, len(t))
		for i, e := range t {
			l[i] = marshal(e)
		}
		return map[string]any{"L": l}
	case map[string]any:
		m := make(map[string]any, len(t))
		for k, vv := range t {
			m[k] = marshal(vv)
		}
		return map[string]any{"M": m}
	}
	return map[string]any{"S": jsnum.ToString(v)}
}

// marshalItem marshals a top-level item without the M wrapper.
func marshalItem(item map[string]any) map[string]any {
	out := make(map[string]any, len(item))
	for k, v := range item {
		out[k] = marshal(v)
	}
	return out
}

// descriptorKeys — the probe set of Node's unmarshal plain-object branch.
// Note: no B, no SS/NS/BS — that's the storage quirk the tests assert.
func isDescriptor(v any) bool {
	m, ok := v.(map[string]any)
	if !ok {
		return false
	}
	for _, k := range [...]string{"S", "N", "BOOL", "M", "L", "NULL"} {
		if _, has := m[k]; has {
			return true
		}
	}
	return false
}

// unmarshal is Node's unmarshal(): probes type keys in Node's order ('S'
// first). N goes through parseFloat. Unrecognized descriptor shapes (SS, B,
// ...) fall through to the plain-object branch and are stored raw.
func unmarshal(v any) any {
	m, ok := v.(map[string]any)
	if !ok {
		return v
	}
	if val, has := m["S"]; has {
		return val
	}
	if val, has := m["N"]; has {
		return jsnum.ParseFloatPrefix(jsnum.ToString(val))
	}
	if val, has := m["BOOL"]; has {
		return val
	}
	if _, has := m["NULL"]; has {
		return nil
	}
	if val, has := m["L"]; has {
		arr, ok := val.([]any)
		if !ok {
			return val
		}
		out := make([]any, len(arr))
		for i, e := range arr {
			out[i] = unmarshal(e)
		}
		return out
	}
	if val, has := m["M"]; has {
		mm, ok := val.(map[string]any)
		if !ok {
			return val
		}
		out := make(map[string]any, len(mm))
		for k, vv := range mm {
			out[k] = unmarshal(vv)
		}
		return out
	}
	// plain object (not DynamoDB format) — unmarshal descriptor-shaped values.
	out := make(map[string]any, len(m))
	for k, vv := range m {
		if isDescriptor(vv) {
			out[k] = unmarshal(vv)
		} else {
			out[k] = vv
		}
	}
	return out
}

// unmarshalMap unmarshals and asserts a map result ({} fallback mirrors the
// `unmarshal(payload.X || {})` call sites).
func unmarshalMap(v any) map[string]any {
	if v == nil {
		v = map[string]any{}
	}
	m, ok := unmarshal(v).(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return m
}

// attrVal reads item[name] with JS semantics: absent → undefined sentinel.
func attrVal(item map[string]any, name string) any {
	v, ok := item[name]
	if !ok {
		return jsnum.Undef
	}
	return v
}

// isUndefined — attr === undefined (absent or explicitly-undefined value).
func isUndefined(v any) bool { return jsnum.IsUndef(v) }

// cmpVals — Node's stable scalar comparator: numbers numeric, otherwise
// String() comparison (JS relational on strings = UTF-16 code units).
func cmpVals(a, b any) int {
	af, aIsN := a.(float64)
	bf, bIsN := b.(float64)
	if aIsN && bIsN {
		if af == bf {
			return 0
		}
		if af < bf {
			return -1
		}
		return 1 // includes NaN pairs, like a===b?0:(a<b?-1:1)
	}
	sa, sb := jsnum.ToString(a), jsnum.ToString(b)
	if sa == sb {
		return 0
	}
	if jsnum.UTF16Compare(sa, sb) < 0 {
		return -1
	}
	return 1
}

// jsonClone is structuredCloneSafe (JSON.parse(JSON.stringify(x))): fresh
// deep tree, NaN/±Inf → null, undefined map entries dropped, undefined array
// elements → null.
func jsonClone(v any) any {
	switch t := v.(type) {
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil
		}
		return t
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			if jsnum.IsUndef(e) {
				out[i] = nil
			} else {
				out[i] = jsonClone(e)
			}
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, vv := range t {
			if jsnum.IsUndef(vv) {
				continue
			}
			out[k] = jsonClone(vv)
		}
		return out
	}
	if jsnum.IsUndef(v) {
		return nil // callers guard top-level undefined themselves
	}
	return v
}

func jsonCloneMap(m map[string]any) map[string]any {
	c, _ := jsonClone(m).(map[string]any)
	if c == nil {
		c = map[string]any{}
	}
	return c
}

// sanitizeJSON prepares an any-tree for encoding/json — same value mapping as
// jsonClone (JSON.stringify semantics). Responses embedding raw stored items
// must pass through this so NaN can't break the encoder.
func sanitizeJSON(v any) any { return jsonClone(v) }

// shallowCopy is the JS `{ ...item }` spread.
func shallowCopy(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// stringifyJSON is JSON.stringify for the any-tree: (result, ok) where
// ok=false means JS returned undefined. Map keys are sorted (Node used
// insertion order; only injectivity matters at our call sites: value
// equality, snapshot bodies, size estimates).
func stringifyJSON(v any) (string, bool) {
	var sb strings.Builder
	ok := writeJSON(&sb, v)
	return sb.String(), ok
}

func writeJSON(sb *strings.Builder, v any) bool {
	switch t := v.(type) {
	case nil:
		sb.WriteString("null")
		return true
	case bool:
		if t {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
		return true
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			sb.WriteString("null")
		} else {
			sb.WriteString(jsnum.Format(t))
		}
		return true
	case string:
		writeJSONString(sb, t)
		return true
	case []any:
		sb.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				sb.WriteByte(',')
			}
			if jsnum.IsUndef(e) {
				sb.WriteString("null")
			} else {
				writeJSON(sb, e)
			}
		}
		sb.WriteByte(']')
		return true
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			if jsnum.IsUndef(t[k]) {
				continue
			}
			keys = append(keys, k)
		}
		sort.Strings(keys)
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			writeJSONString(sb, k)
			sb.WriteByte(':')
			writeJSON(sb, t[k])
		}
		sb.WriteByte('}')
		return true
	}
	if jsnum.IsUndef(v) {
		return false
	}
	sb.WriteString("null")
	return true
}

// writeJSONString escapes like JSON.stringify: the two mandatory characters,
// control chars, and nothing else (no HTML escaping).
func writeJSONString(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		default:
			if r < 0x20 {
				sb.WriteString(`\u`)
				hex := strconv.FormatInt(int64(r), 16)
				for len(hex) < 4 {
					hex = "0" + hex
				}
				sb.WriteString(hex)
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
}

// jsonSizeBytes is `JSON.stringify(v).length` — UTF-16 code units.
func jsonSizeBytes(v any) int {
	s, ok := stringifyJSON(v)
	if !ok {
		return 0
	}
	return jsnum.UTF16Len(s)
}
