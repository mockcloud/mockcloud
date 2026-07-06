// expression.go — 1:1 port of src/services/dynamodb/expression.js: the shared
// tokenizer + Pratt parser + evaluator for ConditionExpression /
// FilterExpression / KeyConditionExpression, plus ProjectionExpression.
//
// Fidelity notes (all verified against the Node source):
//   - type-mismatched comparisons → false, never an error;
//   - size() counts UTF-16 code units for S;
//   - KeyConditionExpression is NOT restricted to key-shaped predicates;
//   - error message strings surface verbatim in ValidationException bodies.
//
// JS `throw` is modelled as a panic carrying jsErr, recovered at the public
// entry points; callers that Node left uncaught re-panic (→ 500 boundary).
package dynamodb

import (
	"fmt"
	"strings"
	"sync"

	"github.com/mockcloud/mockcloud/internal/jsnum"
)

// ── JS-throw plumbing ───────────────────────────────────────────────────────

type jsErr struct{ msg string }

func (e jsErr) Error() string { return e.msg }

func throwf(format string, args ...any) {
	panic(jsErr{fmt.Sprintf(format, args...)})
}

// catchJS converts a jsErr panic into an error; other panics propagate.
func catchJS(err *error) {
	if e := recover(); e != nil {
		if je, ok := e.(jsErr); ok {
			*err = je
			return
		}
		panic(e)
	}
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

type tok struct {
	t    string
	v    any // string for words/placeholders/cmp, float64 for index
	hasV bool
}

// jsonToken reproduces JSON.stringify({t:'x',v:'y'}) — key insertion order.
func (t tok) jsonToken() string {
	var sb strings.Builder
	sb.WriteString(`{"t":`)
	writeJSONString(&sb, t.t)
	if t.hasV {
		sb.WriteString(`,"v":`)
		writeJSON(&sb, t.v)
	}
	sb.WriteByte('}')
	return sb.String()
}

func mkTok(t string) tok            { return tok{t: t} }
func mkTokV(t string, v any) tok    { return tok{t: t, v: v, hasV: true} }
func isWordChar(c rune) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'
}
func isWordStart(c rune) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_'
}
func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

var exprKeywords = map[string]bool{"AND": true, "OR": true, "NOT": true, "BETWEEN": true, "IN": true}

func exprTokenize(src string) []tok {
	var tokens []tok
	rs := []rune(src)
	i := 0
	for i < len(rs) {
		c := rs[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '(':
			tokens = append(tokens, mkTok("lparen"))
			i++
		case c == ')':
			tokens = append(tokens, mkTok("rparen"))
			i++
		case c == ',':
			tokens = append(tokens, mkTok("comma"))
			i++
		case c == '.':
			tokens = append(tokens, mkTok("dot"))
			i++
		case c == '[':
			j := i + 1
			for j < len(rs) && rs[j] != ']' {
				j++
			}
			if j >= len(rs) {
				throwf("Unterminated list index")
			}
			n := strings.TrimSpace(string(rs[i+1 : j]))
			if !isDigits(n) {
				throwf("Invalid list index: %s", n)
			}
			tokens = append(tokens, mkTokV("index", jsnum.ToNumberFromString(n)))
			i = j + 1
		case c == '=':
			tokens = append(tokens, mkTokV("cmp", "="))
			i++
		case c == '<':
			if i+1 < len(rs) && rs[i+1] == '=' {
				tokens = append(tokens, mkTokV("cmp", "<="))
				i += 2
			} else if i+1 < len(rs) && rs[i+1] == '>' {
				tokens = append(tokens, mkTokV("cmp", "<>"))
				i += 2
			} else {
				tokens = append(tokens, mkTokV("cmp", "<"))
				i++
			}
		case c == '>':
			if i+1 < len(rs) && rs[i+1] == '=' {
				tokens = append(tokens, mkTokV("cmp", ">="))
				i += 2
			} else {
				tokens = append(tokens, mkTokV("cmp", ">"))
				i++
			}
		case c == '#':
			j := i + 1
			for j < len(rs) && isWordChar(rs[j]) {
				j++
			}
			tokens = append(tokens, mkTokV("name_ph", string(rs[i:j])))
			i = j
		case c == ':':
			j := i + 1
			for j < len(rs) && isWordChar(rs[j]) {
				j++
			}
			tokens = append(tokens, mkTokV("value_ph", string(rs[i:j])))
			i = j
		case isWordStart(c):
			j := i
			for j < len(rs) && isWordChar(rs[j]) {
				j++
			}
			w := string(rs[i:j])
			if exprKeywords[strings.ToUpper(w)] {
				tokens = append(tokens, mkTokV("kw", strings.ToUpper(w)))
			} else {
				tokens = append(tokens, mkTokV("ident", w))
			}
			i = j
		default:
			throwf("Unexpected character in expression: %c", c)
		}
	}
	return tokens
}

// ── Parser (Pratt-style) ────────────────────────────────────────────────────

type seg struct {
	kind string // attr | name_ph | index
	name string // for attr/name_ph (name_ph keeps the '#')
	idx  int    // for index
}

type astNode struct {
	typ string // and or not cmp between in func path value size

	op          string // cmp
	left, right *astNode
	expr        *astNode // not / between / in subject
	lo, hi      *astNode
	list        []*astNode // in
	name        string     // func name / value placeholder
	args        []*astNode // func
	segs        []seg      // path
	path        *astNode   // size() inner path
}

var boolFuncs = map[string]bool{
	"attribute_exists": true, "attribute_not_exists": true, "attribute_type": true,
	"begins_with": true, "contains": true,
}

type parser struct {
	tokens []tok
	pos    int
}

func (p *parser) peek(off int) *tok {
	if p.pos+off < len(p.tokens) {
		return &p.tokens[p.pos+off]
	}
	return nil
}

func (p *parser) consume() *tok {
	t := p.peek(0)
	p.pos++
	return t
}

func (p *parser) expect(t string, v string) *tok {
	tk := p.peek(0)
	if tk == nil || tk.t != t || (v != "" && tk.v != any(v)) {
		got := "EOF"
		if tk != nil {
			got = tk.jsonToken()
		}
		want := t
		if v != "" {
			want += fmt.Sprintf(" %q", v)
		}
		throwf("Expected %s, got %s", want, got)
	}
	p.pos++
	return tk
}

func exprParse(tokens []tok) *astNode {
	p := &parser{tokens: tokens}
	ast := p.parseExpr()
	if p.pos < len(p.tokens) {
		throwf("Unexpected token at end: %s", p.tokens[p.pos].jsonToken())
	}
	return ast
}

func (p *parser) parseExpr() *astNode { return p.parseOr() }

func (p *parser) parseOr() *astNode {
	left := p.parseAnd()
	for {
		nx := p.peek(0)
		if nx == nil || nx.t != "kw" || nx.v != any("OR") {
			break
		}
		p.consume()
		left = &astNode{typ: "or", left: left, right: p.parseAnd()}
	}
	return left
}

func (p *parser) parseAnd() *astNode {
	left := p.parseNot()
	for {
		nx := p.peek(0)
		if nx == nil || nx.t != "kw" || nx.v != any("AND") {
			break
		}
		p.consume()
		left = &astNode{typ: "and", left: left, right: p.parseNot()}
	}
	return left
}

func (p *parser) parseNot() *astNode {
	nx := p.peek(0)
	if nx != nil && nx.t == "kw" && nx.v == any("NOT") {
		p.consume()
		return &astNode{typ: "not", expr: p.parseNot()}
	}
	return p.parsePrimary()
}

func (p *parser) parsePrimary() *astNode {
	tk := p.peek(0)
	if tk == nil {
		throwf("Unexpected end of expression")
	}
	if tk.t == "lparen" {
		p.consume()
		e := p.parseExpr()
		p.expect("rparen", "")
		return e
	}
	if tk.t == "ident" {
		n1 := p.peek(1)
		if n1 != nil && n1.t == "lparen" && boolFuncs[strings.ToLower(tk.v.(string))] {
			return p.parseFuncCall()
		}
	}
	return p.parseComparison()
}

func (p *parser) parseFuncCall() *astNode {
	name := strings.ToLower(p.consume().v.(string))
	p.expect("lparen", "")
	var args []*astNode
	if nx := p.peek(0); !(nx != nil && nx.t == "rparen") {
		args = append(args, p.parseOperand())
		for {
			nx := p.peek(0)
			if nx == nil || nx.t != "comma" {
				break
			}
			p.consume()
			args = append(args, p.parseOperand())
		}
	}
	p.expect("rparen", "")
	return &astNode{typ: "func", name: name, args: args}
}

func (p *parser) parseOperand() *astNode {
	tk := p.peek(0)
	if tk == nil {
		throwf("Expected operand")
	}
	if tk.t == "value_ph" {
		p.consume()
		return &astNode{typ: "value", name: tk.v.(string)}
	}
	if tk.t == "ident" && strings.ToLower(tk.v.(string)) == "size" {
		if n1 := p.peek(1); n1 != nil && n1.t == "lparen" {
			p.consume()
			p.consume()
			inner := p.parsePath()
			p.expect("rparen", "")
			return &astNode{typ: "size", path: inner}
		}
	}
	if tk.t == "ident" || tk.t == "name_ph" {
		return p.parsePath()
	}
	throwf("Unexpected operand token: %s", tk.jsonToken())
	return nil
}

func (p *parser) parsePath() *astNode {
	var segs []seg
	head := p.consume()
	switch {
	case head == nil:
		throwf("Expected path, got %s", "EOF") // unreachable via callers
	case head.t == "name_ph":
		segs = append(segs, seg{kind: "name_ph", name: head.v.(string)})
	case head.t == "ident":
		segs = append(segs, seg{kind: "attr", name: head.v.(string)})
	default:
		throwf("Expected path, got %s", head.jsonToken())
	}
	for {
		nx := p.peek(0)
		if nx == nil {
			break
		}
		if nx.t == "dot" {
			p.consume()
			part := p.consume()
			if part == nil {
				throwf("Expected path component after '.', got %s", "EOF")
			} else if part.t == "name_ph" {
				segs = append(segs, seg{kind: "name_ph", name: part.v.(string)})
			} else if part.t == "ident" {
				segs = append(segs, seg{kind: "attr", name: part.v.(string)})
			} else {
				throwf("Expected path component after '.', got %s", part.jsonToken())
			}
		} else if nx.t == "index" {
			p.consume()
			segs = append(segs, seg{kind: "index", idx: int(nx.v.(float64))})
		} else {
			break
		}
	}
	return &astNode{typ: "path", segs: segs}
}

func (p *parser) parseComparison() *astNode {
	left := p.parseOperand()
	nx := p.peek(0)
	if nx == nil {
		return left
	}
	if nx.t == "cmp" {
		p.consume()
		return &astNode{typ: "cmp", op: nx.v.(string), left: left, right: p.parseOperand()}
	}
	if nx.t == "kw" && nx.v == any("BETWEEN") {
		p.consume()
		lo := p.parseOperand()
		p.expect("kw", "AND")
		hi := p.parseOperand()
		return &astNode{typ: "between", expr: left, lo: lo, hi: hi}
	}
	if nx.t == "kw" && nx.v == any("IN") {
		p.consume()
		p.expect("lparen", "")
		list := []*astNode{p.parseOperand()}
		for {
			n := p.peek(0)
			if n == nil || n.t != "comma" {
				break
			}
			p.consume()
			list = append(list, p.parseOperand())
		}
		p.expect("rparen", "")
		return &astNode{typ: "in", expr: left, list: list}
	}
	return left
}

// ── Typed values ────────────────────────────────────────────────────────────

// TV = { type, value }. tvNull is JS null (unrecognized descriptor); a nil
// *TV is JS undefined.
type tv struct {
	typ string
	val any
}

var tvNull = &tv{typ: "\x00null"}

// errNullTV mirrors the TypeError Node raised when comparing a null TV.
var errNullTV = "Cannot read properties of null (reading 'type')"

func tvFromDdb(ddb any) *tv {
	m, ok := ddb.(map[string]any)
	if !ok || m == nil {
		return tvNull
	}
	if v, has := m["S"]; has {
		return &tv{typ: "S", val: v}
	}
	if v, has := m["N"]; has {
		return &tv{typ: "N", val: jsnum.ToNumber(v)}
	}
	if v, has := m["BOOL"]; has {
		return &tv{typ: "BOOL", val: jsnum.Truthy(v)}
	}
	if _, has := m["NULL"]; has {
		return &tv{typ: "NULL", val: nil}
	}
	if v, has := m["B"]; has {
		return &tv{typ: "B", val: v}
	}
	if v, has := m["SS"]; has {
		return &tv{typ: "SS", val: asAnySlice(v)}
	}
	if v, has := m["NS"]; has {
		arr := asAnySlice(v)
		out := make([]any, len(arr))
		for i, e := range arr {
			out[i] = jsnum.ToNumber(e)
		}
		return &tv{typ: "NS", val: out}
	}
	if v, has := m["BS"]; has {
		return &tv{typ: "BS", val: asAnySlice(v)}
	}
	if v, has := m["L"]; has {
		arr := asAnySlice(v)
		out := make([]*tv, len(arr))
		for i, e := range arr {
			out[i] = tvFromDdb(e)
		}
		return &tv{typ: "L", val: out}
	}
	if v, has := m["M"]; has {
		mm, _ := v.(map[string]any)
		out := make(map[string]*tv, len(mm))
		for k, e := range mm {
			out[k] = tvFromDdb(e)
		}
		return &tv{typ: "M", val: out}
	}
	return tvNull
}

func asAnySlice(v any) []any {
	arr, _ := v.([]any)
	return arr
}

func tvFromJs(v any) *tv {
	if jsnum.IsUndef(v) {
		return nil // undefined
	}
	switch t := v.(type) {
	case nil:
		return &tv{typ: "NULL", val: nil}
	case string:
		return &tv{typ: "S", val: t}
	case float64:
		return &tv{typ: "N", val: t}
	case bool:
		return &tv{typ: "BOOL", val: t}
	case []any:
		out := make([]*tv, len(t))
		for i, e := range t {
			out[i] = tvFromJs(e)
		}
		return &tv{typ: "L", val: out}
	case map[string]any:
		out := make(map[string]*tv, len(t))
		for k, e := range t {
			out[k] = tvFromJs(e)
		}
		return &tv{typ: "M", val: out}
	}
	return &tv{typ: "S", val: jsnum.ToString(v)}
}

// resolveName resolves a path segment against ExpressionAttributeNames.
func resolveName(sg seg, names map[string]any) string {
	if sg.kind == "attr" {
		return sg.name
	}
	if sg.kind == "name_ph" {
		if names == nil {
			throwf("Unknown name placeholder %s", sg.name)
		}
		v, ok := names[sg.name]
		if !ok {
			throwf("Unknown name placeholder %s", sg.name)
		}
		return jsnum.ToString(v)
	}
	throwf("Index segment cannot be resolved as a name")
	return ""
}

// walkPath walks segs against the raw JS item; jsnum.Undef when missing.
func walkPath(segs []seg, item any, names map[string]any) any {
	cur := item
	for _, sg := range segs {
		if cur == nil || jsnum.IsUndef(cur) {
			return jsnum.Undef
		}
		if sg.kind == "index" {
			arr, ok := cur.([]any)
			if !ok {
				return jsnum.Undef
			}
			if sg.idx < 0 || sg.idx >= len(arr) {
				return jsnum.Undef
			}
			cur = arr[sg.idx]
		} else {
			name := resolveName(sg, names)
			m, ok := cur.(map[string]any)
			if !ok {
				return jsnum.Undef
			}
			cur = attrVal(m, name)
		}
	}
	return cur
}

func resolvePath(path *astNode, item map[string]any, names map[string]any) *tv {
	return tvFromJs(walkPath(path.segs, item, names))
}

type evalCtx struct {
	item   map[string]any
	names  map[string]any
	values map[string]*tv
}

func resolveOperand(n *astNode, ctx *evalCtx) *tv {
	switch n.typ {
	case "value":
		v, ok := ctx.values[n.name]
		if !ok {
			throwf("Unknown value placeholder %s", n.name)
		}
		return v
	case "path":
		return resolvePath(n, ctx.item, ctx.names)
	case "size":
		t := resolvePath(n.path, ctx.item, ctx.names)
		if t == nil {
			return nil
		}
		sz, defined := sizeOf(t)
		if !defined {
			return nil
		}
		return &tv{typ: "N", val: sz}
	}
	throwf("Unexpected operand AST: %s", n.typ)
	return nil
}

func sizeOf(t *tv) (float64, bool) {
	switch t.typ {
	case "S":
		s, _ := t.val.(string)
		return float64(jsnum.UTF16Len(s)), true
	case "B":
		if s, ok := t.val.(string); ok {
			return float64(jsnum.UTF16Len(s)), true
		}
		return 0, true
	case "L":
		l, _ := t.val.([]*tv)
		return float64(len(l)), true
	case "M":
		m, _ := t.val.(map[string]*tv)
		return float64(len(m)), true
	case "SS", "NS", "BS":
		l, _ := t.val.([]any)
		return float64(len(l)), true
	}
	return 0, false
}

// compare — AWS rules: mismatched types → false; N numeric; S/B by UTF-16
// code units; BOOL/NULL only =/<>; L/M/sets deep-equality only.
func compare(op string, a, b *tv) bool {
	if a == nil || b == nil {
		return false
	}
	if a == tvNull || b == tvNull {
		throwf(errNullTV)
	}
	if a.typ != b.typ {
		return false
	}
	var cmp int
	switch a.typ {
	case "N":
		av, _ := a.val.(float64)
		bv, _ := b.val.(float64)
		if av == bv {
			cmp = 0
		} else if av < bv {
			cmp = -1
		} else {
			cmp = 1 // includes NaN, mirroring a===b?0:(a<b?-1:1)
		}
	case "S", "B":
		as, aok := a.val.(string)
		bs, bok := b.val.(string)
		if aok && bok {
			cmp = jsnum.UTF16Compare(as, bs)
		} else if jsnum.StrictEq(a.val, b.val) {
			cmp = 0
		} else {
			cmp = 1
		}
	case "BOOL", "NULL":
		if op != "=" && op != "<>" {
			return false
		}
		if jsnum.StrictEq(a.val, b.val) {
			cmp = 0
		} else {
			cmp = 1
		}
	default:
		if op != "=" && op != "<>" {
			return false
		}
		if deepEqualTv(a, b) {
			cmp = 0
		} else {
			cmp = 1
		}
	}
	switch op {
	case "=":
		return cmp == 0
	case "<>":
		return cmp != 0
	case "<":
		return cmp < 0
	case "<=":
		return cmp <= 0
	case ">":
		return cmp > 0
	case ">=":
		return cmp >= 0
	}
	return false
}

func deepEqualTv(a, b *tv) bool {
	if a == nil || b == nil || a == tvNull || b == tvNull {
		throwf(errNullTV)
	}
	if a.typ != b.typ {
		return false
	}
	switch a.typ {
	case "L":
		al, _ := a.val.([]*tv)
		bl, _ := b.val.([]*tv)
		if len(al) != len(bl) {
			return false
		}
		for i := range al {
			if !deepEqualTv(al[i], bl[i]) {
				return false
			}
		}
		return true
	case "M":
		am, _ := a.val.(map[string]*tv)
		bm, _ := b.val.(map[string]*tv)
		if len(am) != len(bm) {
			return false
		}
		for k, av := range am {
			bv, ok := bm[k]
			if !ok || !deepEqualTv(av, bv) {
				return false
			}
		}
		return true
	case "SS", "BS", "NS":
		al, _ := a.val.([]any)
		bl, _ := b.val.([]any)
		if len(al) != len(bl) {
			return false
		}
		for _, x := range al {
			found := false
			for _, y := range bl {
				if jsnum.SameValueZero(x, y) {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
		return true
	}
	return jsnum.StrictEq(a.val, b.val)
}

// ── Evaluator ───────────────────────────────────────────────────────────────

func evalAst(ast *astNode, ctx *evalCtx) bool {
	switch ast.typ {
	case "and":
		return evalAst(ast.left, ctx) && evalAst(ast.right, ctx)
	case "or":
		return evalAst(ast.left, ctx) || evalAst(ast.right, ctx)
	case "not":
		return !evalAst(ast.expr, ctx)
	case "cmp":
		a := resolveOperand(ast.left, ctx)
		b := resolveOperand(ast.right, ctx)
		return compare(ast.op, a, b)
	case "between":
		v := resolveOperand(ast.expr, ctx)
		lo := resolveOperand(ast.lo, ctx)
		hi := resolveOperand(ast.hi, ctx)
		return compare(">=", v, lo) && compare("<=", v, hi)
	case "in":
		v := resolveOperand(ast.expr, ctx)
		for _, c := range ast.list {
			cv := resolveOperand(c, ctx)
			if compare("=", v, cv) {
				return true
			}
		}
		return false
	case "func":
		return evalFunc(ast, ctx)
	}
	throwf("Unknown AST node: %s", ast.typ)
	return false
}

func evalFunc(n *astNode, ctx *evalCtx) bool {
	var a0, a1 *astNode
	if len(n.args) > 0 {
		a0 = n.args[0]
	}
	if len(n.args) > 1 {
		a1 = n.args[1]
	}
	switch n.name {
	case "attribute_exists":
		if a0 == nil || a0.typ != "path" {
			throwf("attribute_exists requires a path")
		}
		return resolvePath(a0, ctx.item, ctx.names) != nil
	case "attribute_not_exists":
		if a0 == nil || a0.typ != "path" {
			throwf("attribute_not_exists requires a path")
		}
		return resolvePath(a0, ctx.item, ctx.names) == nil
	case "attribute_type":
		if a0 == nil || a1 == nil {
			throwf("Unexpected operand AST: %v", "undefined")
		}
		v := resolveOperand(a0, ctx)
		tp := resolveOperand(a1, ctx)
		if v == nil || tp == nil || tp == tvNull || tp.typ != "S" {
			return false
		}
		if v == tvNull {
			throwf(errNullTV)
		}
		return jsnum.StrictEq(v.typ, tp.val)
	case "begins_with":
		if a0 == nil || a1 == nil {
			throwf("Unexpected operand AST: %v", "undefined")
		}
		v := resolveOperand(a0, ctx)
		p := resolveOperand(a1, ctx)
		if v == nil || v == tvNull || p == nil || p == tvNull {
			return false
		}
		if (v.typ != "S" && v.typ != "B") || v.typ != p.typ {
			return false
		}
		vs, ok := v.val.(string)
		if !ok {
			return false
		}
		return strings.HasPrefix(vs, jsnum.ToString(p.val))
	case "contains":
		if a0 == nil || a1 == nil {
			throwf("Unexpected operand AST: %v", "undefined")
		}
		v := resolveOperand(a0, ctx)
		t := resolveOperand(a1, ctx)
		if v == nil || v == tvNull || t == nil || t == tvNull {
			return false
		}
		if v.typ == "S" && t.typ == "S" {
			vs, _ := v.val.(string)
			ts, _ := t.val.(string)
			return strings.Contains(vs, ts)
		}
		if v.typ == "L" {
			l, _ := v.val.([]*tv)
			for _, x := range l {
				if deepEqualTv(x, t) {
					return true
				}
			}
			return false
		}
		if v.typ == "SS" || v.typ == "NS" || v.typ == "BS" {
			l, _ := v.val.([]any)
			for _, x := range l {
				if jsnum.StrictEq(x, t.val) {
					return true
				}
			}
			return false
		}
		return false
	}
	throwf("Unknown function: %s", n.name)
	return false
}

// ── Public entry (package-internal) ─────────────────────────────────────────

var exprCacheMu sync.Mutex
var exprCache = map[string]*astNode{}

func compileExpr(expr string) *astNode {
	exprCacheMu.Lock()
	ast, ok := exprCache[expr]
	exprCacheMu.Unlock()
	if ok {
		return ast
	}
	ast = exprParse(exprTokenize(expr))
	exprCacheMu.Lock()
	exprCache[expr] = ast
	exprCacheMu.Unlock()
	return ast
}

func buildValues(rawExprValues map[string]any) map[string]*tv {
	out := map[string]*tv{}
	for k, v := range rawExprValues {
		out[k] = tvFromDdb(v)
	}
	return out
}

// evaluateCondition — true/false, or an error carrying the JS message that
// callers surface as a ValidationException.
func evaluateCondition(expr string, item map[string]any, exprNames map[string]any, rawExprValues map[string]any) (result bool, err error) {
	defer catchJS(&err)
	if expr == "" {
		return true, nil
	}
	ast := compileExpr(expr)
	if item == nil {
		item = map[string]any{}
	}
	ctx := &evalCtx{item: item, names: exprNames, values: buildValues(rawExprValues)}
	return evalAst(ast, ctx), nil
}

// evaluatePredicate — same engine (KeyConditionExpression is NOT restricted).
func evaluatePredicate(expr string, item map[string]any, exprNames map[string]any, rawExprValues map[string]any) (bool, error) {
	return evaluateCondition(expr, item, exprNames, rawExprValues)
}

// ── Projection ──────────────────────────────────────────────────────────────

var projCacheMu sync.Mutex
var projCache = map[string][][]seg{}

func compileProjection(expr string) [][]seg {
	projCacheMu.Lock()
	paths, ok := projCache[expr]
	projCacheMu.Unlock()
	if ok {
		return paths
	}
	tokens := exprTokenize(expr)
	i := 0
	segsFor := func() []seg {
		var segs []seg
		if i >= len(tokens) || (tokens[i].t != "ident" && tokens[i].t != "name_ph") {
			throwf("Invalid ProjectionExpression: expected attribute path")
		}
		t := tokens[i]
		if t.t == "name_ph" {
			segs = append(segs, seg{kind: "name_ph", name: t.v.(string)})
		} else {
			segs = append(segs, seg{kind: "attr", name: t.v.(string)})
		}
		i++
		for i < len(tokens) {
			t = tokens[i]
			if t.t == "dot" {
				i++
				if i >= len(tokens) || (tokens[i].t != "ident" && tokens[i].t != "name_ph") {
					throwf(`Invalid ProjectionExpression: expected name after "."`)
				}
				part := tokens[i]
				if part.t == "name_ph" {
					segs = append(segs, seg{kind: "name_ph", name: part.v.(string)})
				} else {
					segs = append(segs, seg{kind: "attr", name: part.v.(string)})
				}
				i++
			} else if t.t == "index" {
				segs = append(segs, seg{kind: "index", idx: int(t.v.(float64))})
				i++
			} else {
				break
			}
		}
		return segs
	}
	paths = append(paths, segsFor())
	for i < len(tokens) {
		if tokens[i].t != "comma" {
			throwf(`Invalid ProjectionExpression: expected ","`)
		}
		i++
		paths = append(paths, segsFor())
	}
	projCacheMu.Lock()
	projCache[expr] = paths
	projCacheMu.Unlock()
	return paths
}

// setBySegs materialises nested maps/arrays along the path — the shared
// Node helper (expression.js setBySegs === update.js setPath semantics).
func setBySegs(out map[string]any, segs []seg, value any, names map[string]any) {
	setInto(out, segs, value, names)
}

// setInto applies segs into container, returning the (possibly re-allocated)
// container so slice growth propagates to the parent.
func setInto(container any, segs []seg, value any, names map[string]any) any {
	if len(segs) == 0 {
		return container
	}
	sg := segs[0]
	last := len(segs) == 1
	// Node computes keyOrIdx before touching the container, so an unknown
	// name placeholder throws regardless of the container's type.
	var key string
	if sg.kind != "index" {
		key = resolveName(sg, names)
	} else {
		key = jsnum.Format(float64(sg.idx)) // numeric property on an object
	}
	newChild := func() any {
		if segs[1].kind == "index" {
			return []any{}
		}
		return map[string]any{}
	}
	switch c := container.(type) {
	case map[string]any:
		if last {
			c[key] = value
			return c
		}
		next := c[key]
		if next == nil || jsnum.IsUndef(next) {
			next = newChild()
		}
		c[key] = setInto(next, segs[1:], value, names)
		return c
	case []any:
		if sg.kind != "index" {
			return c // named property on an array — invisible to JSON, no-op
		}
		grown := growSlice(c, sg.idx)
		if last {
			grown[sg.idx] = value
			return grown
		}
		next := grown[sg.idx]
		if next == nil || jsnum.IsUndef(next) {
			next = newChild()
		}
		grown[sg.idx] = setInto(next, segs[1:], value, names)
		return grown
	}
	return container // descending into a scalar: JS silently ignores
}

// growSlice extends s so idx is addressable; JS holes → null in JSON.
func growSlice(s []any, idx int) []any {
	for len(s) <= idx {
		s = append(s, nil)
	}
	return s
}

// projectItem returns a pruned copy containing only the named paths.
func projectItem(item map[string]any, projectionExpr string, exprNames map[string]any) (out map[string]any, err error) {
	defer catchJS(&err)
	if projectionExpr == "" {
		return item, nil
	}
	paths := compileProjection(projectionExpr)
	out = map[string]any{}
	for _, segs := range paths {
		val := walkPath(segs, item, exprNames)
		if !jsnum.IsUndef(val) {
			setBySegs(out, segs, val, exprNames)
		}
	}
	return out, nil
}
