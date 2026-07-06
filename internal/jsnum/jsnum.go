// Package jsnum implements the ECMAScript number/string coercions the
// DynamoDB port depends on. Every DynamoDB `N` value flows through Format
// (ECMA-262 §6.1.6.1.20 Number::toString), and the expression/update engines
// use ToNumber / parseFloat / parseInt semantics, so byte-compatibility with
// V8 output is a conformance requirement — see the fixture test cross-checked
// against `node -e "console.log(String(x))"`.
package jsnum

import (
	"math"
	"strconv"
	"strings"
)

// Undefined is the JS `undefined` sentinel used across the DynamoDB port to
// distinguish "attribute missing" from JSON null (which unmarshals to nil).
type Undefined struct{}

// Undef is the canonical undefined value.
var Undef = Undefined{}

// IsUndef reports whether v is the JS-undefined sentinel.
func IsUndef(v any) bool {
	_, ok := v.(Undefined)
	return ok
}

// Format is ECMAScript Number::toString(10): shortest round-trip digits,
// plain decimal for 1e-6 <= |x| < 1e21, JS exponent form otherwise.
// String(-0) === "0", String(NaN) === "NaN", String(Infinity) === "Infinity".
func Format(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if f == 0 { // covers -0
		return "0"
	}
	if f < 0 {
		return "-" + Format(-f)
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	// Shortest-round-trip digits via strconv 'e' formatting: "d[.ddd]e±dd".
	s := strconv.FormatFloat(f, 'e', -1, 64)
	ePos := strings.IndexByte(s, 'e')
	mant := s[:ePos]
	exp, _ := strconv.Atoi(s[ePos+1:])
	digits := strings.Replace(mant, ".", "", 1)
	k := len(digits)
	// value = digits × 10^(n-k) per the spec's (s, k, n) decomposition.
	n := exp + 1
	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	default:
		e := n - 1
		expPart := "e+"
		if e < 0 {
			expPart = "e-"
			e = -e
		}
		expPart += strconv.Itoa(e)
		if k == 1 {
			return digits + expPart
		}
		return digits[:1] + "." + digits[1:] + expPart
	}
}

// ToString is JS String(v) over the MockCloud any-tree
// (nil|string|float64|bool|[]any|map[string]any|Undefined).
func ToString(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case float64:
		return Format(t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	case []any:
		// Array.prototype.toString → join(","); null/undefined elements → "".
		parts := make([]string, len(t))
		for i, e := range t {
			if e == nil || IsUndef(e) {
				parts[i] = ""
			} else {
				parts[i] = ToString(e)
			}
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	case Undefined:
		return "undefined"
	}
	return "undefined"
}

// jsWhitespace matches the WhiteSpace + LineTerminator set Number()/parseFloat
// trim (includes NBSP and BOM, which unicode.IsSpace misses/differs on).
func isJSSpace(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\r', '\v', '\f', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func trimJS(s string) string {
	return strings.TrimFunc(s, isJSSpace)
}

// Trim is String.prototype.trim (JS whitespace set).
func Trim(s string) string { return trimJS(s) }

// ToNumber is JS ToNumber(v): Number('')===0, Number(null)===0,
// Number(undefined)===NaN, arrays via join, objects → NaN.
func ToNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case bool:
		if t {
			return 1
		}
		return 0
	case float64:
		return t
	case string:
		return ToNumberFromString(t)
	case []any:
		return ToNumberFromString(ToString(t))
	case map[string]any:
		return math.NaN()
	}
	return math.NaN() // undefined and anything exotic
}

var decimalDigits = "0123456789"

// ToNumberFromString is JS Number(string): full-string match of the
// StringNumericLiteral grammar (decimal, hex/oct/bin without sign, Infinity),
// empty/whitespace-only → 0, otherwise NaN.
func ToNumberFromString(s string) float64 {
	s = trimJS(s)
	if s == "" {
		return 0
	}
	sign := 1.0
	body := s
	if body[0] == '+' || body[0] == '-' {
		if body[0] == '-' {
			sign = -1
		}
		body = body[1:]
	}
	if body == "Infinity" {
		return sign * math.Inf(1)
	}
	// Radix prefixes: no sign allowed in JS (checked on the unsigned string).
	if len(s) >= 2 && s[0] == '0' {
		switch s[1] {
		case 'x', 'X':
			return parseRadix(s[2:], 16)
		case 'o', 'O':
			return parseRadix(s[2:], 8)
		case 'b', 'B':
			return parseRadix(s[2:], 2)
		}
	}
	if !isDecimalLiteral(body) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		if strings.Contains(err.Error(), "out of range") {
			return f // ±Inf, like JS
		}
		return math.NaN()
	}
	return f
}

// isDecimalLiteral matches (\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)? exactly.
func isDecimalLiteral(s string) bool {
	i := 0
	digits := func() int {
		n := 0
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			n++
		}
		return n
	}
	intDigits := digits()
	if i < len(s) && s[i] == '.' {
		i++
		frac := digits()
		if intDigits == 0 && frac == 0 {
			return false
		}
	} else if intDigits == 0 {
		return false
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		if digits() == 0 {
			return false
		}
	}
	return i == len(s)
}

func parseRadix(s string, radix int) float64 {
	if s == "" {
		return math.NaN()
	}
	f := 0.0
	for _, c := range s {
		d := -1
		switch {
		case c >= '0' && c <= '9':
			d = int(c - '0')
		case c >= 'a' && c <= 'f':
			d = int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			d = int(c-'A') + 10
		}
		if d < 0 || d >= radix {
			return math.NaN()
		}
		f = f*float64(radix) + float64(d)
	}
	return f
}

// ParseFloatPrefix is JS parseFloat: longest numeric prefix (decimal only —
// no hex), NaN when none. parseFloat('30abc') === 30, parseFloat('') === NaN.
func ParseFloatPrefix(s string) float64 {
	s = strings.TrimLeftFunc(s, isJSSpace)
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	if strings.HasPrefix(s[i:], "Infinity") {
		if i == 1 && s[0] == '-' {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	start := i
	intEnd := i
	for intEnd < len(s) && s[intEnd] >= '0' && s[intEnd] <= '9' {
		intEnd++
	}
	i = intEnd
	fracEnd := i
	if i < len(s) && s[i] == '.' {
		j := i + 1
		for j < len(s) && s[j] >= '0' && s[j] <= '9' {
			j++
		}
		// "." alone counts only if digits on either side exist.
		if j > i+1 || intEnd > start {
			fracEnd = j
		}
	}
	if fracEnd > i {
		i = fracEnd
	}
	if i == start || (i == start+1 && s[start] == '.') {
		return math.NaN()
	}
	// Optional exponent — only valid with digits after it.
	end := i
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		j := i + 1
		if j < len(s) && (s[j] == '+' || s[j] == '-') {
			j++
		}
		k := j
		for k < len(s) && s[k] >= '0' && s[k] <= '9' {
			k++
		}
		if k > j {
			end = k
		}
	}
	f, err := strconv.ParseFloat(s[:end], 64)
	if err != nil {
		if strings.Contains(err.Error(), "out of range") {
			return f
		}
		return math.NaN()
	}
	return f
}

// ParseIntPrefix is JS parseInt(s, 10): trims, optional sign, decimal digit
// prefix; NaN when no digits.
func ParseIntPrefix(s string) float64 {
	s = strings.TrimLeftFunc(s, isJSSpace)
	i := 0
	sign := 1.0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		if s[i] == '-' {
			sign = -1
		}
		i++
	}
	start := i
	f := 0.0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		f = f*10 + float64(s[i]-'0')
		i++
	}
	if i == start {
		return math.NaN()
	}
	return sign * f
}

// StrictEq is JS === over the any-tree: scalars by value, objects/arrays by
// reference (always false across separately built trees), NaN !== NaN.
func StrictEq(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case string:
		y, ok := b.(string)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case Undefined:
		return IsUndef(b)
	}
	return false
}

// SameValueZero — the Set membership predicate (NaN equals NaN).
func SameValueZero(a, b any) bool {
	if af, ok := a.(float64); ok {
		if bf, ok2 := b.(float64); ok2 {
			return af == bf || (math.IsNaN(af) && math.IsNaN(bf))
		}
		return false
	}
	return StrictEq(a, b)
}

// Falsy is JS falsiness: undefined, null, false, 0, NaN, "".
func Falsy(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case bool:
		return !t
	case float64:
		return t == 0 || math.IsNaN(t)
	case string:
		return t == ""
	case Undefined:
		return true
	}
	return false
}

// Truthy = !Falsy.
func Truthy(v any) bool { return !Falsy(v) }

// UTF16Len is JS String.prototype.length — UTF-16 code units, not bytes or
// runes.
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// UTF16Compare orders two strings by UTF-16 code units (JS < / >), which
// differs from Go's byte order for supplementary-plane characters.
func UTF16Compare(a, b string) int {
	ar, br := []rune(a), []rune(b)
	au, bu := runesToUnits(ar), runesToUnits(br)
	for i := 0; i < len(au) && i < len(bu); i++ {
		if au[i] != bu[i] {
			if au[i] < bu[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(au) < len(bu):
		return -1
	case len(au) > len(bu):
		return 1
	}
	return 0
}

func runesToUnits(rs []rune) []uint16 {
	out := make([]uint16, 0, len(rs))
	for _, r := range rs {
		if r > 0xFFFF {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			out = append(out, uint16(r))
		}
	}
	return out
}
