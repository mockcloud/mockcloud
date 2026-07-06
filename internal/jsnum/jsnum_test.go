package jsnum

import (
	"math"
	"testing"
)

// Fixture table generated with:
//
//	node -e "for (const x of [...]) console.log(String(x))"
//
// (see the values in the second column). Format must be byte-identical to
// V8's Number::toString — DynamoDB N marshalling depends on it.
func TestFormat(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{3, "3"},
		{1.5, "1.5"},
		{0.000001, "0.000001"},
		{1e-7, "1e-7"},
		{1e21, "1e+21"},
		{1e20, "100000000000000000000"},
		{math.Copysign(0, -1), "0"},
		{math.NaN(), "NaN"},
		{math.Inf(1), "Infinity"},
		{math.Inf(-1), "-Infinity"},
		{0.1, "0.1"},
		{100, "100"},
		{123.456, "123.456"},
		{5e-324, "5e-324"},
		{1.7976931348623157e308, "1.7976931348623157e+308"},
		{0.30000000000000004, "0.30000000000000004"},
		{2.5e-10, "2.5e-10"},
		{1234567890123456789, "1234567890123456800"},
		{9007199254740993, "9007199254740992"},
		{-42.75, "-42.75"},
		{1e6, "1000000"},
		{999999999999999999999, "1e+21"},
		{0.0000001234, "1.234e-7"},
		{6.02e23, "6.02e+23"},
		{1e-21, "1e-21"},
		{7.2e-7, "7.2e-7"},
		{-1e-7, "-1e-7"},
		{3.141592653589793, "3.141592653589793"},
		{2, "2"},
		{1.5e-6, "0.0000015"},
	}
	for _, c := range cases {
		if got := Format(c.in); got != c.want {
			t.Errorf("Format(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

// node -e "for (const s of [...]) console.log(String(parseFloat(s)))"
func TestParseFloatPrefix(t *testing.T) {
	cases := []struct {
		in   string
		want string // compared via Format so NaN/Infinity are representable
	}{
		{"30abc", "30"},
		{"", "NaN"},
		{".5", "0.5"},
		{"5.", "5"},
		{"1e", "1"},
		{"1e5", "100000"},
		{"0x10", "0"},
		{"Infinityz", "Infinity"},
		{"-Infinity", "-Infinity"},
		{"  12.5rem", "12.5"},
		{".", "NaN"},
		{"+-3", "NaN"},
		{"1.2.3", "1.2"},
	}
	for _, c := range cases {
		if got := Format(ParseFloatPrefix(c.in)); got != c.want {
			t.Errorf("parseFloat(%q) = %s, want %s", c.in, got, c.want)
		}
	}
}

// node -e "for (const s of [...]) console.log(String(Number(s)))"
func TestToNumberFromString(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", "0"},
		{"   ", "0"},
		{"12", "12"},
		{"0x1f", "31"},
		{"0o17", "15"},
		{"0b101", "5"},
		{"1e3", "1000"},
		{" 12 ", "12"},
		{"12px", "NaN"},
		{"Infinity", "Infinity"},
		{"-Infinity", "-Infinity"},
		{"0x", "NaN"},
		{".5", "0.5"},
		{"5.", "5"},
		{"+7", "7"},
		{"1_0", "NaN"},
	}
	for _, c := range cases {
		if got := Format(ToNumberFromString(c.in)); got != c.want {
			t.Errorf("Number(%q) = %s, want %s", c.in, got, c.want)
		}
	}
}

func TestToNumberCoercions(t *testing.T) {
	// Number(null)===0, Number(undefined)===NaN, Number([])===0,
	// Number(['5'])===5, Number([1,2])===NaN, Number({})===NaN.
	if ToNumber(nil) != 0 {
		t.Error("Number(null) != 0")
	}
	if !math.IsNaN(ToNumber(Undef)) {
		t.Error("Number(undefined) not NaN")
	}
	if ToNumber([]any{}) != 0 {
		t.Error("Number([]) != 0")
	}
	if ToNumber([]any{"5"}) != 5 {
		t.Error("Number(['5']) != 5")
	}
	if !math.IsNaN(ToNumber([]any{1.0, 2.0})) {
		t.Error("Number([1,2]) not NaN")
	}
	if !math.IsNaN(ToNumber(map[string]any{})) {
		t.Error("Number({}) not NaN")
	}
	if ToNumber(true) != 1 || ToNumber(false) != 0 {
		t.Error("Number(bool) wrong")
	}
}

func TestParseIntPrefix(t *testing.T) {
	if ParseIntPrefix("30abc") != 30 {
		t.Error("parseInt('30abc') != 30")
	}
	if !math.IsNaN(ParseIntPrefix("abc")) {
		t.Error("parseInt('abc') not NaN")
	}
	if ParseIntPrefix(" -42x") != -42 {
		t.Error("parseInt(' -42x') != -42")
	}
}

func TestUTF16(t *testing.T) {
	// '😀' is 2 code units; 'é' is 1.
	if UTF16Len("😀") != 2 || UTF16Len("abé") != 3 {
		t.Error("UTF16Len wrong")
	}
	// '�' (U+FFFD) > '😀' (U+1F600, lead surrogate 0xD83D) in UTF-16
	// code-unit order, though byte order says otherwise.
	if UTF16Compare("�", "😀") != 1 {
		t.Error("UTF16Compare not code-unit ordered")
	}
	if UTF16Compare("a", "ab") != -1 || UTF16Compare("b", "a") != 1 || UTF16Compare("x", "x") != 0 {
		t.Error("UTF16Compare basic ordering wrong")
	}
}

func TestToString(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{nil, "null"},
		{Undef, "undefined"},
		{true, "true"},
		{[]any{1.0, nil, 2.0}, "1,,2"},
		{[]any{[]any{1.0, 2.0}, 3.0}, "1,2,3"},
		{map[string]any{"a": 1.0}, "[object Object]"},
	}
	for _, c := range cases {
		if got := ToString(c.in); got != c.want {
			t.Errorf("String(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
