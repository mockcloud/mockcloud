package sns

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"github.com/mockcloud/mockcloud/internal/state"
)

// Filter-policy evaluation (subset: exact, anything-but, prefix, numeric,
// exists) over message attributes (default) or the message body. Quirks kept
// from Node: no policy → match; UNPARSEABLE policy JSON → match (deliver!);
// MessageBody scope with unparseable message → NO match; `anything-but` is
// type-strict ("5" never equals 5); scalar policy specs are ignored.

func subscriptionMatches(sub *state.Subscription, attributes map[string]any, message string) bool {
	if sub.FilterPolicy == nil || *sub.FilterPolicy == "" {
		return true
	}
	var policy map[string]any
	if err := json.Unmarshal([]byte(*sub.FilterPolicy), &policy); err != nil {
		return true
	}
	scope := sub.FilterPolicyScope
	if scope == "" {
		scope = "MessageAttributes"
	}
	if scope == "MessageBody" {
		var bodyObj map[string]any
		if err := json.Unmarshal([]byte(message), &bodyObj); err != nil {
			return false
		}
		return matchPolicyObject(policy, bodyObj, true)
	}
	return matchPolicyObject(policy, attributesToPlain(attributes), true)
}

func attributesToPlain(attrs map[string]any) map[string]any {
	out := map[string]any{}
	for name, raw := range attrs {
		out[name] = attrValueForMatch(raw)
	}
	return out
}

func attrValueForMatch(raw any) any {
	a, _ := raw.(map[string]any)
	if a == nil {
		return nil
	}
	dt, _ := a["DataType"].(string)
	if dt == "" {
		dt, _ = a["Type"].(string)
	}
	if dt == "" {
		dt = "String"
	}
	val := a["StringValue"]
	if val == nil {
		val = a["Value"]
	}
	if val == nil {
		val = a["BinaryValue"]
	}
	if strings.HasPrefix(dt, "Number") {
		return jsNumber(val)
	}
	if dt == "String.Array" {
		if s, ok := val.(string); ok {
			var arr any
			if err := json.Unmarshal([]byte(s), &arr); err == nil {
				return arr
			}
		}
		return val
	}
	return val
}

// objPresent: obj is a decoded JSON map (or nil for "undefined").
func matchPolicyObject(policy map[string]any, obj map[string]any, objDefined bool) bool {
	for key, spec := range policy {
		var value any
		present := false
		if objDefined && obj != nil {
			value, present = obj[key]
		}
		switch sp := spec.(type) {
		case []any:
			if !matchKey(sp, present, value) {
				return false
			}
		case map[string]any:
			// Nested object → recurse (MessageBody scope only).
			nested, _ := value.(map[string]any)
			if !matchPolicyObject(sp, nested, present) {
				return false
			}
		}
		// Scalar specs: silently ignored (no constraint), like Node.
	}
	return true
}

func matchKey(conditions []any, present bool, value any) bool {
	values, isArr := value.([]any)
	if !isArr {
		values = []any{value}
	}
	for _, cond := range conditions {
		if condMap, ok := cond.(map[string]any); ok {
			if existsSpec, has := condMap["exists"]; has {
				want, _ := existsSpec.(bool)
				if want == present {
					return true
				}
				continue
			}
		}
		if !present {
			continue
		}
		for _, v := range values {
			if matchCondition(cond, v) {
				return true
			}
		}
	}
	return false
}

func matchCondition(cond, val any) bool {
	switch c := cond.(type) {
	case string:
		s, ok := val.(string)
		return ok && s == c
	case float64:
		n := jsNumber(val)
		return !math.IsNaN(n) && n == c
	case bool:
		b, ok := val.(bool)
		return ok && b == c
	case map[string]any:
		if ab, has := c["anything-but"]; has {
			set, isArr := ab.([]any)
			if !isArr {
				set = []any{ab}
			}
			for _, member := range set {
				if strictEq(member, val) {
					return false
				}
			}
			return true
		}
		if p, has := c["prefix"]; has {
			prefix, _ := p.(string)
			s, ok := val.(string)
			return ok && strings.HasPrefix(s, prefix)
		}
		if num, has := c["numeric"]; has {
			spec, _ := num.([]any)
			return matchNumeric(spec, val)
		}
	}
	return false
}

func matchNumeric(spec []any, val any) bool {
	n := jsNumber(val)
	if math.IsNaN(n) {
		return false
	}
	for i := 0; i+1 < len(spec); i += 2 {
		op, _ := spec[i].(string)
		operand := jsNumber(spec[i+1])
		switch op {
		case "=":
			if n != operand {
				return false
			}
		case "<":
			if !(n < operand) {
				return false
			}
		case "<=":
			if !(n <= operand) {
				return false
			}
		case ">":
			if !(n > operand) {
				return false
			}
		case ">=":
			if !(n >= operand) {
				return false
			}
		}
	}
	return true
}

// strictEq — JS === over decoded-JSON values (never cross-type).
func strictEq(a, b any) bool {
	switch av := a.(type) {
	case string:
		bv, ok := b.(string)
		return ok && av == bv
	case float64:
		bv, ok := b.(float64)
		return ok && av == bv
	case bool:
		bv, ok := b.(bool)
		return ok && av == bv
	case nil:
		return b == nil
	}
	return false
}

// jsNumber — JS Number() coercion for the values this evaluator sees.
func jsNumber(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case json.Number:
		f, err := n.Float64()
		if err != nil {
			return math.NaN()
		}
		return f
	case string:
		s := strings.TrimSpace(n)
		if s == "" {
			return 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	case bool:
		if n {
			return 1
		}
		return 0
	case nil:
		return 0
	}
	return math.NaN()
}
