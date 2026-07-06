// update.go — 1:1 port of src/services/dynamodb/update.js: the
// UpdateExpression engine (SET / REMOVE / ADD / DELETE).
//
// Fidelity notes:
//   - clauses split by a whole-word case-insensitive regex on the RAW string
//     (duplicate SET → last occurrence wins);
//   - if_not_exists falls back ONLY when the path is missing (stored JSON
//     null counts as existing);
//   - SET arithmetic uses JS Number coercion (Number(null)===0, so
//     arithmetic over JSON-null succeeds; missing → NaN → throws);
//   - ADD decides set-vs-number from the RAW value descriptor (SS|NS|BS);
//   - DELETE with an empty result removes the attribute;
//   - list_append wraps non-arrays;
//   - `changed` = top-level names in clause order (index-headed paths → null,
//     which pickAttrs skips).
package dynamodb

import (
	"math"
	"regexp"
	"strings"

	"github.com/mockcloud/mockcloud/internal/jsnum"
)

// ── Tokenizer (update grammar) ──────────────────────────────────────────────

func updTokenize(src string) []tok {
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
		case c == '=':
			tokens = append(tokens, mkTok("eq"))
			i++
		case c == '+':
			tokens = append(tokens, mkTok("plus"))
			i++
		case c == '-':
			tokens = append(tokens, mkTok("minus"))
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
			tokens = append(tokens, mkTokV("ident", string(rs[i:j])))
			i = j
		default:
			throwf("Unexpected character in UpdateExpression: %c", c)
		}
	}
	return tokens
}

// ── Clause splitting ────────────────────────────────────────────────────────

var clauseRe = regexp.MustCompile(`(?i)\b(SET|REMOVE|ADD|DELETE)\b`)

// splitClauses locates the clause keywords as whole words (case-insensitive)
// in the raw string. Later duplicates overwrite earlier ones.
func splitClauses(expr string) map[string]string {
	out := map[string]string{}
	locs := clauseRe.FindAllStringSubmatchIndex(expr, -1)
	for k, m := range locs {
		kw := strings.ToUpper(expr[m[2]:m[3]])
		bodyStart := m[1]
		end := len(expr)
		if k+1 < len(locs) {
			end = locs[k+1][0]
		}
		out[kw] = strings.TrimSpace(expr[bodyStart:end])
	}
	return out
}

// ── Path helpers (operate on JS items) ──────────────────────────────────────

// getPath — update.js getPath (same walk as the expression engine's).
func getPath(item map[string]any, segs []seg, names map[string]any) any {
	return walkPath(segs, item, names)
}

// setPath — update.js setPath (delegates to the shared materialiser).
func setPath(item map[string]any, segs []seg, value any, names map[string]any) {
	setInto(item, segs, value, names)
}

// removePath — update.js removePath.
func removePath(item map[string]any, segs []seg, names map[string]any) {
	var cur any = item
	for k := 0; k < len(segs); k++ {
		sg := segs[k]
		last := k == len(segs)-1
		var key string
		if sg.kind != "index" {
			key = resolveName(sg, names)
		}
		if cur == nil || jsnum.IsUndef(cur) {
			return
		}
		if last {
			if sg.kind == "index" {
				if arr, ok := cur.([]any); ok && sg.idx >= 0 && sg.idx < len(arr) {
					// splice(idx, 1) mutates in place — copy down and shrink,
					// then propagate: arrays are mutated via the parent
					// reference in JS; we mirror by rewriting through parents.
					copy(arr[sg.idx:], arr[sg.idx+1:])
					shrinkParent(item, segs[:k], arr[:len(arr)-1], names)
				}
			} else if m, ok := cur.(map[string]any); ok {
				delete(m, key)
			}
			return
		}
		switch c := cur.(type) {
		case map[string]any:
			if sg.kind == "index" {
				cur = attrVal(c, jsnum.Format(float64(sg.idx)))
			} else {
				cur = attrVal(c, key)
			}
		case []any:
			if sg.kind == "index" && sg.idx >= 0 && sg.idx < len(c) {
				cur = c[sg.idx]
			} else {
				cur = jsnum.Undef
			}
		default:
			cur = jsnum.Undef
		}
	}
}

// shrinkParent re-assigns a shortened slice into its parent container (Go
// slices can't shrink in place through an interface value).
func shrinkParent(item map[string]any, parentSegs []seg, shrunk []any, names map[string]any) {
	if len(parentSegs) == 0 {
		return // the item root is a map; an index-headed path can't reach here
	}
	setInto(item, parentSegs, shrunk, names)
}

// ── Token-stream cursor ─────────────────────────────────────────────────────

type cursor struct {
	tokens []tok
	pos    int
}

func (c *cursor) peek(off int) *tok {
	if c.pos+off < len(c.tokens) {
		return &c.tokens[c.pos+off]
	}
	return nil
}
func (c *cursor) next() *tok {
	t := c.peek(0)
	c.pos++
	return t
}
func (c *cursor) eof() bool { return c.pos >= len(c.tokens) }
func (c *cursor) expect(t string) *tok {
	tk := c.peek(0)
	if tk == nil || tk.t != t {
		got := "EOF"
		if tk != nil {
			got = tk.t
		}
		throwf("Expected %s, got %s", t, got)
	}
	c.pos++
	return tk
}

func updParsePath(c *cursor) []seg {
	var segs []seg
	head := c.next()
	if head == nil {
		throwf("Expected path")
	}
	switch head.t {
	case "name_ph":
		segs = append(segs, seg{kind: "name_ph", name: head.v.(string)})
	case "ident":
		segs = append(segs, seg{kind: "attr", name: head.v.(string)})
	default:
		throwf("Expected path, got %s", head.t)
	}
	for !c.eof() {
		nx := c.peek(0)
		if nx.t == "dot" {
			c.next()
			part := c.next()
			if part == nil {
				throwf(`Expected name after "."`)
			} else if part.t == "name_ph" {
				segs = append(segs, seg{kind: "name_ph", name: part.v.(string)})
			} else if part.t == "ident" {
				segs = append(segs, seg{kind: "attr", name: part.v.(string)})
			} else {
				throwf(`Expected name after "."`)
			}
		} else if nx.t == "index" {
			c.next()
			segs = append(segs, seg{kind: "index", idx: int(nx.v.(float64))})
		} else {
			break
		}
	}
	return segs
}

// ── SET operand evaluation ──────────────────────────────────────────────────

type updVal struct {
	js    any
	raw   map[string]any
	isSet bool
}

func evalUpdOperand(c *cursor, item map[string]any, names map[string]any, vals map[string]updVal) any {
	left := evalUpdTerm(c, item, names, vals)
	nx := c.peek(0)
	if nx != nil && (nx.t == "plus" || nx.t == "minus") {
		c.next()
		right := evalUpdTerm(c, item, names, vals)
		a, b := jsnum.ToNumber(left), jsnum.ToNumber(right)
		if math.IsNaN(a) || math.IsNaN(b) {
			throwf("Arithmetic on non-numeric operand in UpdateExpression")
		}
		if nx.t == "plus" {
			return a + b
		}
		return a - b
	}
	return left
}

func evalUpdTerm(c *cursor, item map[string]any, names map[string]any, vals map[string]updVal) any {
	tk := c.peek(0)
	if tk == nil {
		throwf("Expected operand in SET")
	}
	if tk.t == "value_ph" {
		c.next()
		v, ok := vals[tk.v.(string)]
		if !ok {
			throwf("Unknown value placeholder %s", tk.v.(string))
		}
		return v.js
	}
	if tk.t == "ident" {
		if n1 := c.peek(1); n1 != nil && n1.t == "lparen" {
			fn := strings.ToLower(tk.v.(string))
			switch fn {
			case "if_not_exists":
				c.next()
				c.next() // ident, lparen
				segs := updParsePath(c)
				c.expect("comma")
				fallback := evalUpdOperand(c, item, names, vals)
				c.expect("rparen")
				existing := getPath(item, segs, names)
				if jsnum.IsUndef(existing) {
					return fallback
				}
				return existing
			case "list_append":
				c.next()
				c.next()
				a := evalUpdOperand(c, item, names, vals)
				c.expect("comma")
				b := evalUpdOperand(c, item, names, vals)
				c.expect("rparen")
				la := wrapList(a)
				lb := wrapList(b)
				out := make([]any, 0, len(la)+len(lb))
				out = append(out, la...)
				out = append(out, lb...)
				return out
			default:
				throwf("Unknown function in SET: %s", fn)
			}
		}
	}
	segs := updParsePath(c)
	return getPath(item, segs, names)
}

// wrapList — Array.isArray(a) ? a : (a === undefined ? [] : [a]).
func wrapList(v any) []any {
	if arr, ok := v.([]any); ok {
		return arr
	}
	if jsnum.IsUndef(v) {
		return []any{}
	}
	return []any{v}
}

// ── Set helpers for ADD / DELETE ────────────────────────────────────────────

func asArray(v any) []any {
	if arr, ok := v.([]any); ok {
		out := make([]any, len(arr))
		copy(out, arr)
		return out
	}
	return []any{}
}

// updEq — a === b || JSON.stringify(a) === JSON.stringify(b).
func updEq(a, b any) bool {
	if jsnum.StrictEq(a, b) {
		return true
	}
	sa, aok := stringifyJSON(a)
	sb, bok := stringifyJSON(b)
	return aok && bok && sa == sb
}

func unionSet(a any, b []any) []any {
	out := asArray(a)
	for _, x := range b {
		found := false
		for _, y := range out {
			if updEq(y, x) {
				found = true
				break
			}
		}
		if !found {
			out = append(out, x)
		}
	}
	return out
}

// diffSet — asArray(a).filter(x => !b.some(y => eq(y, x))). The `b.some`
// crash on a non-array operand only fires when `a` has elements, exactly like
// the JS filter callback.
func diffSet(a any, b any) []any {
	out := []any{}
	for _, x := range asArray(a) {
		barr, ok := b.([]any)
		if !ok {
			throwf("b.some is not a function")
		}
		found := false
		for _, y := range barr {
			if updEq(y, x) {
				found = true
				break
			}
		}
		if !found {
			out = append(out, x)
		}
	}
	return out
}

// ── Public entry ────────────────────────────────────────────────────────────

type updateResult struct {
	item    map[string]any
	changed []string
}

// applyUpdate — see update.js applyUpdate. rawValues distinguishes sets from
// lists; jsValues is the same map unmarshalled to JS.
func applyUpdate(oldItem map[string]any, updateExpr string, exprNames map[string]any,
	rawValues map[string]any, jsValues map[string]any) (res updateResult, err error) {
	defer catchJS(&err)

	names := exprNames
	vals := map[string]updVal{}
	for k, v := range jsValues {
		var raw map[string]any
		if rawValues != nil {
			raw, _ = rawValues[k].(map[string]any)
		}
		isSet := false
		if raw != nil {
			_, ss := raw["SS"]
			_, ns := raw["NS"]
			_, bs := raw["BS"]
			isSet = ss || ns || bs
		}
		js := v
		if isSet {
			if ssv, has := raw["SS"]; has {
				js = asArray(ssv)
			} else if nsv, has := raw["NS"]; has {
				arr := asArray(nsv)
				out := make([]any, len(arr))
				for i, e := range arr {
					out[i] = jsnum.ToNumber(e)
				}
				js = out
			} else {
				js = asArray(raw["BS"])
			}
		}
		vals[k] = updVal{js: js, raw: raw, isSet: isSet}
	}

	var item map[string]any
	if oldItem != nil {
		item = jsonCloneMap(oldItem)
	} else {
		item = map[string]any{}
	}
	var changed []string
	seen := map[string]bool{}
	addChanged := func(name string) {
		if !seen[name] {
			seen[name] = true
			changed = append(changed, name)
		}
	}
	clauses := splitClauses(updateExpr)

	if body := clauses["SET"]; body != "" {
		c := &cursor{tokens: updTokenize(body)}
		for !c.eof() {
			segs := updParsePath(c)
			c.expect("eq")
			value := evalUpdOperand(c, item, names, vals)
			setPath(item, segs, value, names)
			addChanged(topName(segs, names))
			if !c.eof() {
				c.expect("comma")
			}
		}
	}

	if body := clauses["REMOVE"]; body != "" {
		c := &cursor{tokens: updTokenize(body)}
		for !c.eof() {
			segs := updParsePath(c)
			removePath(item, segs, names)
			addChanged(topName(segs, names))
			if !c.eof() {
				c.expect("comma")
			}
		}
	}

	if body := clauses["ADD"]; body != "" {
		c := &cursor{tokens: updTokenize(body)}
		for !c.eof() {
			segs := updParsePath(c)
			tk := c.expect("value_ph")
			operand, ok := vals[tk.v.(string)]
			if !ok {
				throwf("Unknown value placeholder %s", tk.v.(string))
			}
			existing := getPath(item, segs, names)
			if operand.isSet {
				members, _ := operand.js.([]any) // isSet ⇒ built as []any above
				setPath(item, segs, unionSet(existing, members), names)
			} else {
				base := 0.0
				if !jsnum.IsUndef(existing) {
					base = jsnum.ToNumber(existing)
				}
				setPath(item, segs, base+jsnum.ToNumber(operand.js), names)
			}
			addChanged(topName(segs, names))
			if !c.eof() {
				c.expect("comma")
			}
		}
	}

	if body := clauses["DELETE"]; body != "" {
		c := &cursor{tokens: updTokenize(body)}
		for !c.eof() {
			segs := updParsePath(c)
			tk := c.expect("value_ph")
			operand, ok := vals[tk.v.(string)]
			if !ok {
				throwf("Unknown value placeholder %s", tk.v.(string))
			}
			existing := getPath(item, segs, names)
			result := diffSet(existing, operand.js)
			if len(result) == 0 {
				removePath(item, segs, names)
			} else {
				setPath(item, segs, result, names)
			}
			addChanged(topName(segs, names))
			if !c.eof() {
				c.expect("comma")
			}
		}
	}

	return updateResult{item: item, changed: changed}, nil
}

// topName — segs[0] index-headed → "" (JS null; both are skipped by
// pickAttrs' falsy check).
func topName(segs []seg, names map[string]any) string {
	if segs[0].kind == "index" {
		return ""
	}
	return resolveName(segs[0], names)
}
