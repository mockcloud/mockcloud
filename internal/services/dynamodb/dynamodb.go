// Package dynamodb — full port of src/services/dynamodb.js: the DynamoDB
// JSON protocol (X-Amz-Target: DynamoDB_20120810.*), the expression/update
// engines, disk persistence, streams, and the /mockcloud/dynamodb/* UI
// control plane.
//
// Storage model: state.DynamoDBState.Tables is an any-tree
// (map[string]map[string]any) exactly mirroring Node's plain JS objects —
// items are stored unmarshalled (nil|string|float64|bool|[]any|map[string]any,
// with jsnum.Undef standing in for JS undefined).
//
// Every handler runs in ONE store.With section (the Node event-loop turn).
// Errors Node caught become 400 responses with the same strings; errors Node
// left uncaught panic into the top-level boundary (500 InternalFailure),
// matching src behavior.
package dynamodb

import (
	"math"
	mrand "math/rand"
	"net/http"
	"sort"
	"strings"

	"github.com/mockcloud/mockcloud/internal/config"
	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

type Service struct {
	st   *store.Store
	cfg  *config.Config
	pers *persistence

	// InvokeTrigger fires a DynamoDB-stream Lambda trigger outside the store
	// lock (wired by dispatch in M6; nil = no-op scaffold, like s3.Deliver).
	InvokeTrigger func(fnName string, event map[string]any)
}

func New(st *store.Store, cfg *config.Config) *Service {
	s := &Service{st: st, cfg: cfg}
	s.pers = newPersistence(st, cfg)
	return s
}

// ── table accessors (any-tree helpers) ──────────────────────────────────────

func tblItems(t map[string]any) []any {
	items, _ := t["items"].([]any)
	return items
}

func tblPK(t map[string]any) string { return jsnum.ToString(attrVal(t, "pk")) }

// tblSK returns "" when the table has no (truthy) sort key.
func tblSK(t map[string]any) string {
	v := attrVal(t, "sk")
	if jsnum.Falsy(v) {
		return ""
	}
	return jsnum.ToString(v)
}

// itemMatchesKey — i[pk] === key[pk] && (!sk || i[sk] === key[sk]) with JS
// undefined===undefined semantics.
func itemMatchesKey(item, key map[string]any, pk, sk string) bool {
	if !jsnum.StrictEq(attrVal(item, pk), attrVal(key, pk)) {
		return false
	}
	if sk == "" {
		return true
	}
	return jsnum.StrictEq(attrVal(item, sk), attrVal(key, sk))
}

func findItemIdx(t map[string]any, key map[string]any) int {
	pk, sk := tblPK(t), tblSK(t)
	for i, v := range tblItems(t) {
		item, _ := v.(map[string]any)
		if item != nil && itemMatchesKey(item, key, pk, sk) {
			return i
		}
	}
	return -1
}

// ── key/index plumbing ──────────────────────────────────────────────────────

type keyInfo struct {
	pk, sk string
	index  map[string]any
}

func keyAttrs(t map[string]any, indexName any) keyInfo {
	if jsnum.Truthy(indexName) {
		if idxs, ok := t["indexes"].([]any); ok {
			for _, v := range idxs {
				ix, _ := v.(map[string]any)
				if ix != nil && jsnum.StrictEq(ix["name"], indexName) {
					sk := ""
					if jsnum.Truthy(attrVal(ix, "sk")) {
						sk = jsnum.ToString(ix["sk"])
					}
					return keyInfo{pk: jsnum.ToString(attrVal(ix, "pk")), sk: sk, index: ix}
				}
			}
		}
	}
	return keyInfo{pk: tblPK(t), sk: tblSK(t)}
}

// indexProjectionAttrs — nil when the full item should come back (projection
// ALL or a base-table read); otherwise the ordered attribute set: table key,
// index key, then INCLUDE NonKeyAttributes.
func indexProjectionAttrs(t map[string]any, index map[string]any) []string {
	if index == nil || jsnum.Falsy(attrVal(index, "projection")) ||
		jsnum.StrictEq(index["projection"], "ALL") {
		return nil
	}
	var attrs []string
	seen := map[string]bool{}
	add := func(v any) {
		if jsnum.Truthy(v) {
			name := jsnum.ToString(v)
			if !seen[name] {
				seen[name] = true
				attrs = append(attrs, name)
			}
		}
	}
	add(attrVal(t, "pk"))
	add(attrVal(t, "sk"))
	add(attrVal(index, "pk"))
	add(attrVal(index, "sk"))
	if jsnum.StrictEq(index["projection"], "INCLUDE") {
		if nka, ok := index["nonKeyAttributes"].([]any); ok {
			for _, a := range nka {
				add(a)
			}
		}
	}
	return attrs
}

func pickProjected(item map[string]any, attrs []string) map[string]any {
	out := map[string]any{}
	for _, a := range attrs {
		if !isUndefined(attrVal(item, a)) {
			out[a] = item[a]
		}
	}
	return out
}

func pickAttrs(item map[string]any, attrs []string) map[string]any {
	out := map[string]any{}
	for _, a := range attrs {
		if a != "" && !isUndefined(attrVal(item, a)) {
			out[a] = item[a]
		}
	}
	return out
}

// sortByKey — deterministic (pk, sk) ordering. Stable, like V8's sort.
func sortByKey(items []any, pk, sk string) []any {
	out := make([]any, len(items))
	copy(out, items)
	sort.SliceStable(out, func(a, b int) bool {
		x, _ := out[a].(map[string]any)
		y, _ := out[b].(map[string]any)
		c := cmpVals(attrVal(x, pk), attrVal(y, pk))
		if c != 0 || sk == "" {
			return c < 0
		}
		return cmpVals(attrVal(x, sk), attrVal(y, sk)) < 0
	})
	return out
}

func lastKeyOf(item map[string]any, pk, sk string) map[string]any {
	k := map[string]any{pk: marshal(attrVal(item, pk))}
	if sk != "" {
		k[sk] = marshal(attrVal(item, sk))
	}
	return k
}

func afterStartKey(items []any, startKey any, pk, sk string) []any {
	if jsnum.Falsy(startKey) {
		return items
	}
	sKey := unmarshalMap(startKey)
	for i, v := range items {
		item, _ := v.(map[string]any)
		if item == nil {
			continue
		}
		if jsnum.StrictEq(attrVal(item, pk), attrVal(sKey, pk)) &&
			(sk == "" || jsnum.StrictEq(attrVal(item, sk), attrVal(sKey, sk))) {
			return items[i+1:]
		}
	}
	return items
}

// ── condition plumbing ──────────────────────────────────────────────────────

type condRes struct {
	ok         bool
	failed     bool
	validation string
}

func mapField(payload map[string]any, key string) map[string]any {
	m, _ := payload[key].(map[string]any)
	return m
}

func tryCondition(expr any, existing map[string]any, names, values map[string]any) condRes {
	if jsnum.Falsy(expr) {
		return condRes{ok: true}
	}
	s, isStr := expr.(string)
	if isStr && strings.TrimSpace(s) == "" {
		return condRes{validation: "Invalid ConditionExpression: The expression cannot be empty"}
	}
	if !isStr {
		return condRes{validation: "Unexpected end of expression"}
	}
	passed, err := evaluateCondition(s, existing, names, values)
	if err != nil {
		return condRes{validation: err.Error()}
	}
	if passed {
		return condRes{ok: true}
	}
	return condRes{failed: true}
}

func missingKeyAttr(t map[string]any, item map[string]any) string {
	pk := tblPK(t)
	if item == nil || isUndefined(attrVal(item, pk)) {
		return pk
	}
	if sk := tblSK(t); sk != "" && isUndefined(attrVal(item, sk)) {
		return sk
	}
	return ""
}

func missingKeyInKey(t map[string]any, key map[string]any) string {
	return missingKeyAttr(t, key)
}

func jsonOrUndefined(v any) string {
	s, ok := stringifyJSON(v)
	if !ok {
		return "undefined"
	}
	return s
}

func txKeyID(tableName string, t, key map[string]any) string {
	pkv := attrVal(key, tblPK(t))
	var skv any
	if sk := tblSK(t); sk != "" {
		skv = attrVal(key, sk)
	}
	return tableName + "\x00" + jsonOrUndefined(pkv) + "\x00" + jsonOrUndefined(skv)
}

func respondConditionalFailed(w http.ResponseWriter, existing map[string]any, returnValues string) {
	body := map[string]any{
		"__type":  "ConditionalCheckFailedException",
		"message": "The conditional request failed",
	}
	if returnValues == "ALL_OLD" && existing != nil {
		body["Item"] = marshalItem(existing)
	}
	respond.JSON(w, 400, body)
}

// recordDynamoOp — the store.recordDynamoOp port (per-table metrics +
// CloudWatch series).
func recordDynamoOp(st *state.State, tableName, kind string, units float64) {
	t := st.DynamoDB.Tables[tableName]
	if t == nil {
		return
	}
	m, _ := t["metrics"].(map[string]any)
	if m == nil {
		m = map[string]any{
			"reads": 0.0, "writes": 0.0, "consumedRead": 0.0, "consumedWrite": 0.0,
			"latencySum": 0.0, "latencyCount": 0.0,
		}
		t["metrics"] = m
	}
	base := 1.0
	if kind == "write" {
		base = 2.0
	}
	lat := math.Round((base+mrand.Float64()*3)*100) / 100
	num := func(k string) float64 { f, _ := m[k].(float64); return f }
	if kind == "read" {
		m["reads"] = num("reads") + 1
		m["consumedRead"] = num("consumedRead") + units
	}
	if kind == "write" {
		m["writes"] = num("writes") + 1
		m["consumedWrite"] = num("consumedWrite") + units
	}
	m["latencySum"] = num("latencySum") + lat
	m["latencyCount"] = num("latencyCount") + 1

	capName := "ConsumedReadCapacityUnits"
	if kind == "write" {
		capName = "ConsumedWriteCapacityUnits"
	}
	st.PutMetric("MockCloud/DynamoDB", capName+"/"+tableName, units, "")
	st.PutMetric("MockCloud/DynamoDB", "SuccessfulRequestLatency/"+tableName, lat, "Milliseconds")
}

// sweepExpired — lazy TTL sweep on read paths.
func (s *Service) sweepExpired(t map[string]any) {
	ttl, _ := t["ttl"].(map[string]any)
	if ttl == nil || !jsnum.Truthy(ttl["enabled"]) || !jsnum.Truthy(ttl["attribute"]) {
		return
	}
	now := float64(state.NowMs()) / 1000
	attrName := jsnum.ToString(ttl["attribute"])
	expired := func(v any) bool {
		item, _ := v.(map[string]any)
		if item == nil {
			return false
		}
		f, isNum := item[attrName].(float64)
		return isNum && f <= now
	}
	items := tblItems(t)
	hasExpired := false
	for _, it := range items {
		if expired(it) {
			hasExpired = true
			break
		}
	}
	if hasExpired {
		kept := []any{}
		for _, it := range items {
			if !expired(it) {
				kept = append(kept, it)
			}
		}
		t["items"] = kept
		s.pers.Persist()
	}
}

// ── HTTP entry ──────────────────────────────────────────────────────────────

func (s *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	target := r.Header.Get("x-amz-target")
	op := target
	if i := strings.LastIndex(target, "."); i >= 0 {
		op = target[i+1:]
	}
	payload := jsifyMap(r.JSONBody())

	s.st.With(func(st *state.State) {
		switch op {
		case "CreateTable":
			s.createTable(st, w, payload)
		case "DeleteTable":
			s.deleteTable(st, w, payload)
		case "DescribeTable":
			s.describeTable(st, w, payload)
		case "UpdateTable":
			s.updateTable(st, w, payload)
		case "ListTables":
			s.listTables(st, w, payload)
		case "PutItem":
			s.putItem(st, w, payload)
		case "GetItem":
			s.getItem(st, w, payload)
		case "DeleteItem":
			s.deleteItem(st, w, payload)
		case "UpdateItem":
			s.updateItem(st, w, payload)
		case "Query":
			s.query(st, w, payload)
		case "Scan":
			s.scan(st, w, payload)
		case "BatchWriteItem":
			s.batchWrite(st, w, payload)
		case "BatchGetItem":
			s.batchGet(st, w, payload)
		case "TransactWriteItems":
			s.transactWrite(st, w, payload)
		case "TransactGetItems":
			s.transactGet(st, w, payload)
		case "UpdateTimeToLive":
			s.updateTimeToLive(st, w, payload)
		case "DescribeTimeToLive":
			s.describeTimeToLive(st, w, payload)
		case "TagResource":
			s.tagResource(st, w, payload)
		case "UntagResource":
			s.untagResource(st, w, payload)
		case "ListTagsOfResource":
			s.listTagsOfResource(st, w, payload)
		default:
			respond.ErrorJSON(w, 400, "UnknownOperationException", "Unknown operation: "+op)
		}
	})
}

// tableAndName resolves payload.TableName like JS property access (coerced
// key; String(undefined) === "undefined" surfaces in error messages).
func tableAndName(st *state.State, payload map[string]any) (map[string]any, string) {
	name := jsnum.ToString(attrVal(payload, "TableName"))
	return st.DynamoDB.Tables[name], name
}

// ── table CRUD ──────────────────────────────────────────────────────────────

func findKeyAttr(keySchema any, keyType string) any {
	arr, _ := keySchema.([]any)
	for _, v := range arr {
		m, _ := v.(map[string]any)
		if m != nil && jsnum.StrictEq(m["KeyType"], keyType) {
			return attrVal(m, "AttributeName")
		}
	}
	return jsnum.Undef
}

func streamLabelNow() string {
	iso := state.ISO(state.NowMs())
	iso = strings.ReplaceAll(iso, ":", "-")
	return strings.ReplaceAll(iso, ".", "-")
}

func normalizeIndex(def map[string]any, typ string) map[string]any {
	pk := findKeyAttr(def["KeySchema"], "HASH")
	sk := findKeyAttr(def["KeySchema"], "RANGE")
	var pkOut, skOut any
	if !jsnum.Falsy(pk) {
		pkOut = pk
	}
	if !jsnum.Falsy(sk) {
		skOut = sk
	}
	proj, _ := def["Projection"].(map[string]any)
	projection := any("ALL")
	var nonKey any = []any{}
	if proj != nil {
		if jsnum.Truthy(proj["ProjectionType"]) {
			projection = proj["ProjectionType"]
		}
		if jsnum.Truthy(proj["NonKeyAttributes"]) {
			nonKey = proj["NonKeyAttributes"]
		}
	}
	return map[string]any{
		"name":             attrValOrNil(def, "IndexName"),
		"type":             typ,
		"pk":               pkOut,
		"sk":               skOut,
		"projection":       projection,
		"nonKeyAttributes": nonKey,
		"created":          float64(state.NowMs()),
	}
}

// attrValOrNil — raw field value; JS undefined becomes a stored undefined
// (Node stored `def.IndexName` verbatim).
func attrValOrNil(m map[string]any, key string) any {
	v, ok := m[key]
	if !ok {
		return jsnum.Undef
	}
	return v
}

func (s *Service) createTable(st *state.State, w http.ResponseWriter, payload map[string]any) {
	nameRaw := attrVal(payload, "TableName")
	if jsnum.Falsy(nameRaw) {
		respond.ErrorJSON(w, 400, "ValidationException", "TableName is required")
		return
	}
	name := jsnum.ToString(nameRaw)
	if st.DynamoDB.Tables[name] != nil {
		respond.ErrorJSON(w, 400, "ResourceInUseException", "Table "+name+" already exists")
		return
	}

	pkAttr := "id"
	if v := findKeyAttr(payload["KeySchema"], "HASH"); !jsnum.Falsy(v) {
		pkAttr = jsnum.ToString(v)
	}
	var skAttr any
	if v := findKeyAttr(payload["KeySchema"], "RANGE"); !jsnum.Falsy(v) {
		skAttr = v
	}

	stream, _ := payload["StreamSpecification"].(map[string]any)
	streamEnabled := stream != nil && jsnum.Truthy(stream["StreamEnabled"])
	streamViewType := "NEW_AND_OLD_IMAGES"
	if stream != nil && jsnum.Truthy(stream["StreamViewType"]) {
		streamViewType = jsnum.ToString(stream["StreamViewType"])
	}
	var streamCreated any
	if streamEnabled {
		streamCreated = streamLabelNow()
	}

	indexes := []any{}
	if gsis, ok := payload["GlobalSecondaryIndexes"].([]any); ok {
		for _, g := range gsis {
			if m, ok := g.(map[string]any); ok {
				indexes = append(indexes, normalizeIndex(m, "GSI"))
			}
		}
	}
	if lsis, ok := payload["LocalSecondaryIndexes"].([]any); ok {
		for _, l := range lsis {
			if m, ok := l.(map[string]any); ok {
				indexes = append(indexes, normalizeIndex(m, "LSI"))
			}
		}
	}

	billingMode := "PAY_PER_REQUEST"
	if jsnum.Truthy(payload["BillingMode"]) {
		billingMode = jsnum.ToString(payload["BillingMode"])
	}

	st.DynamoDB.Tables[name] = map[string]any{
		"name": name, "pk": pkAttr, "sk": skAttr,
		"billingMode":    billingMode,
		"items":          []any{},
		"indexes":        indexes,
		"created":        float64(state.NowMs()),
		"arn":            state.Arn("dynamodb", "table/"+name),
		"streamEnabled":  streamEnabled,
		"streamViewType": streamViewType,
		"streamCreated":  streamCreated,
	}
	st.AddTrail(map[string]any{"method": "POST", "path": "/dynamodb/CreateTable/" + name, "status": 200, "latency": 2})
	s.pers.Persist()
	respond.JSON(w, 200, map[string]any{"TableDescription": describeTableObj(st, name)})
}

func (s *Service) deleteTable(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t, name := tableAndName(st, payload)
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Table "+name+" not found")
		return
	}
	desc := describeTableObj(st, name)
	delete(st.DynamoDB.Tables, name)
	st.AddTrail(map[string]any{"method": "POST", "path": "/dynamodb/DeleteTable/" + name, "status": 200, "latency": 1})
	s.pers.Persist()
	respond.JSON(w, 200, map[string]any{"TableDescription": desc})
}

func (s *Service) describeTable(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t, name := tableAndName(st, payload)
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Table "+name+" not found")
		return
	}
	respond.JSON(w, 200, map[string]any{"Table": describeTableObj(st, name)})
}

func (s *Service) listTables(st *state.State, w http.ResponseWriter, _ map[string]any) {
	names := make([]string, 0, len(st.DynamoDB.Tables))
	for n := range st.DynamoDB.Tables {
		names = append(names, n)
	}
	respond.JSON(w, 200, map[string]any{"TableNames": names})
}

func (s *Service) updateTable(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t, name := tableAndName(st, payload)
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Table "+name+" not found")
		return
	}

	if jsnum.Truthy(payload["BillingMode"]) {
		t["billingMode"] = payload["BillingMode"]
	}

	if spec, ok := payload["StreamSpecification"].(map[string]any); ok && spec != nil {
		t["streamEnabled"] = jsnum.Truthy(spec["StreamEnabled"])
		if jsnum.Truthy(spec["StreamViewType"]) {
			t["streamViewType"] = spec["StreamViewType"]
		} else if !jsnum.Truthy(attrVal(t, "streamViewType")) {
			t["streamViewType"] = "NEW_AND_OLD_IMAGES"
		}
		if jsnum.Truthy(t["streamEnabled"]) && !jsnum.Truthy(attrVal(t, "streamCreated")) {
			t["streamCreated"] = streamLabelNow()
		}
	}

	if _, ok := t["indexes"].([]any); !ok {
		t["indexes"] = []any{}
	}
	if upds, ok := payload["GlobalSecondaryIndexUpdates"].([]any); ok {
		for _, u := range upds {
			upd, _ := u.(map[string]any)
			if upd == nil {
				continue
			}
			indexes, _ := t["indexes"].([]any)
			if create, ok := upd["Create"].(map[string]any); ok && create != nil {
				exists := false
				for _, v := range indexes {
					if ix, ok := v.(map[string]any); ok && jsnum.StrictEq(ix["name"], create["IndexName"]) {
						exists = true
						break
					}
				}
				if !exists {
					t["indexes"] = append(indexes, normalizeIndex(create, "GSI"))
				}
			} else if del, ok := upd["Delete"].(map[string]any); ok && del != nil {
				kept := []any{}
				for _, v := range indexes {
					if ix, ok := v.(map[string]any); ok && jsnum.StrictEq(ix["name"], del["IndexName"]) {
						continue
					}
					kept = append(kept, v)
				}
				t["indexes"] = kept
			} else if u2, ok := upd["Update"].(map[string]any); ok && u2 != nil {
				for _, v := range indexes {
					ix, _ := v.(map[string]any)
					if ix != nil && jsnum.StrictEq(ix["name"], u2["IndexName"]) {
						if proj, ok := u2["Projection"].(map[string]any); ok && proj != nil {
							if jsnum.Truthy(proj["ProjectionType"]) {
								ix["projection"] = proj["ProjectionType"]
							}
						}
						break
					}
				}
			}
		}
	}

	st.AddTrail(map[string]any{"method": "POST", "path": "/dynamodb/UpdateTable/" + name, "status": 200, "latency": 2})
	s.pers.Persist()
	respond.JSON(w, 200, map[string]any{"TableDescription": describeTableObj(st, name)})
}

// ── TTL ─────────────────────────────────────────────────────────────────────

func (s *Service) updateTimeToLive(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t, name := tableAndName(st, payload)
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Table "+name+" not found")
		return
	}
	spec, _ := payload["TimeToLiveSpecification"].(map[string]any)
	if spec == nil {
		spec = map[string]any{}
	}
	var attrName any
	if jsnum.Truthy(spec["AttributeName"]) {
		attrName = spec["AttributeName"]
	}
	t["ttl"] = map[string]any{"enabled": jsnum.Truthy(spec["Enabled"]), "attribute": attrName}
	s.pers.Persist()
	ttl := t["ttl"].(map[string]any)
	respond.JSON(w, 200, map[string]any{"TimeToLiveSpecification": map[string]any{
		"Enabled": ttl["enabled"], "AttributeName": ttl["attribute"],
	}})
}

func (s *Service) describeTimeToLive(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t, name := tableAndName(st, payload)
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Table "+name+" not found")
		return
	}
	ttl, _ := t["ttl"].(map[string]any)
	desc := map[string]any{"TimeToLiveStatus": "DISABLED"}
	if ttl != nil && jsnum.Truthy(ttl["enabled"]) {
		desc["TimeToLiveStatus"] = "ENABLED"
	}
	if ttl != nil && jsnum.Truthy(ttl["attribute"]) {
		desc["AttributeName"] = ttl["attribute"]
	}
	respond.JSON(w, 200, map[string]any{"TimeToLiveDescription": desc})
}

// ── Tags ────────────────────────────────────────────────────────────────────

func tableByArn(st *state.State, resourceArn any) map[string]any {
	for name, t := range st.DynamoDB.Tables {
		a := attrVal(t, "arn")
		if jsnum.Falsy(a) {
			a = state.Arn("dynamodb", "table/"+jsnum.ToString(attrVal(t, "name")))
			_ = name
		}
		if jsnum.StrictEq(a, resourceArn) {
			return t
		}
	}
	return nil
}

func (s *Service) tagResource(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t := tableByArn(st, attrVal(payload, "ResourceArn"))
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Resource not found")
		return
	}
	tags, _ := t["tags"].(map[string]any)
	if tags == nil {
		tags = map[string]any{}
		t["tags"] = tags
	}
	if list, ok := payload["Tags"].([]any); ok {
		for _, v := range list {
			m, _ := v.(map[string]any)
			if m == nil {
				continue
			}
			tags[jsnum.ToString(attrVal(m, "Key"))] = attrValOrNil(m, "Value")
		}
	}
	s.pers.Persist()
	respond.JSON(w, 200, map[string]any{})
}

func (s *Service) untagResource(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t := tableByArn(st, attrVal(payload, "ResourceArn"))
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Resource not found")
		return
	}
	if keys, ok := payload["TagKeys"].([]any); ok {
		for _, k := range keys {
			if tags, ok := t["tags"].(map[string]any); ok {
				delete(tags, jsnum.ToString(k))
			}
		}
	}
	s.pers.Persist()
	respond.JSON(w, 200, map[string]any{})
}

func (s *Service) listTagsOfResource(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t := tableByArn(st, attrVal(payload, "ResourceArn"))
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Resource not found")
		return
	}
	tagList := []any{}
	if tags, ok := t["tags"].(map[string]any); ok {
		keys := make([]string, 0, len(tags))
		for k := range tags {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			tagList = append(tagList, map[string]any{"Key": k, "Value": tags[k]})
		}
	}
	respond.JSON(w, 200, sanitizeJSON(map[string]any{"Tags": tagList}))
}

// ── item ops ────────────────────────────────────────────────────────────────

func (s *Service) putItem(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t, name := tableAndName(st, payload)
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Table "+name+" not found")
		return
	}
	item := unmarshalMap(payload["Item"])
	if missing := missingKeyAttr(t, item); missing != "" {
		respond.ErrorJSON(w, 400, "ValidationException",
			"One or more parameter values were invalid: Missing the key "+missing+" in the item")
		return
	}
	idx := findItemIdx(t, item)
	var oldImage map[string]any
	if idx >= 0 {
		oldImage = shallowCopy(tblItems(t)[idx].(map[string]any))
	}

	cond := tryCondition(payload["ConditionExpression"], oldImage,
		mapField(payload, "ExpressionAttributeNames"), mapField(payload, "ExpressionAttributeValues"))
	if cond.validation != "" {
		respond.ErrorJSON(w, 400, "ValidationException", cond.validation)
		return
	}
	if cond.failed {
		respondConditionalFailed(w, oldImage, httpapi.Str(payload, "ReturnValuesOnConditionCheckFailure"))
		return
	}

	items := tblItems(t)
	if idx >= 0 {
		items[idx] = item
	} else {
		t["items"] = append(items, item)
	}
	recordDynamoOp(st, name, "write", 1)
	event := "INSERT"
	if oldImage != nil {
		event = "MODIFY"
	}
	s.emitStreamRecord(st, name, event, oldImage, item)
	s.pers.Persist()

	out := map[string]any{}
	if httpapi.Str(payload, "ReturnValues") == "ALL_OLD" && oldImage != nil {
		out["Attributes"] = marshalItem(oldImage)
	}
	respond.JSON(w, 200, out)
}

func (s *Service) getItem(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t, name := tableAndName(st, payload)
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Table "+name+" not found")
		return
	}
	s.sweepExpired(t)
	key := unmarshalMap(payload["Key"])
	var item map[string]any
	pk, sk := tblPK(t), tblSK(t)
	for _, v := range tblItems(t) {
		m, _ := v.(map[string]any)
		if m != nil && itemMatchesKey(m, key, pk, sk) {
			item = m
			break
		}
	}
	recordDynamoOp(st, name, "read", 1)
	if item != nil && jsnum.Truthy(payload["ProjectionExpression"]) {
		projected, err := projectItem(item, httpapi.Str(payload, "ProjectionExpression"),
			mapField(payload, "ExpressionAttributeNames"))
		if err != nil {
			panic(err) // Node left this uncaught → 500 boundary
		}
		item = projected
	}
	if item != nil {
		respond.JSON(w, 200, map[string]any{"Item": marshalItem(item)})
		return
	}
	respond.JSON(w, 200, map[string]any{})
}

func (s *Service) deleteItem(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t, name := tableAndName(st, payload)
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Table "+name+" not found")
		return
	}
	key := unmarshalMap(payload["Key"])
	if missing := missingKeyInKey(t, key); missing != "" {
		respond.ErrorJSON(w, 400, "ValidationException",
			"The provided key element does not match the schema (missing "+missing+")")
		return
	}
	idx := findItemIdx(t, key)
	var existing map[string]any
	if idx >= 0 {
		existing, _ = tblItems(t)[idx].(map[string]any)
	}

	cond := tryCondition(payload["ConditionExpression"], existing,
		mapField(payload, "ExpressionAttributeNames"), mapField(payload, "ExpressionAttributeValues"))
	if cond.validation != "" {
		respond.ErrorJSON(w, 400, "ValidationException", cond.validation)
		return
	}
	if cond.failed {
		respondConditionalFailed(w, existing, httpapi.Str(payload, "ReturnValuesOnConditionCheckFailure"))
		return
	}

	out := map[string]any{}
	if idx >= 0 {
		items := tblItems(t)
		oldImage := shallowCopy(items[idx].(map[string]any))
		t["items"] = append(items[:idx], items[idx+1:]...)
		s.emitStreamRecord(st, name, "REMOVE", oldImage, nil)
		if httpapi.Str(payload, "ReturnValues") == "ALL_OLD" {
			out["Attributes"] = marshalItem(oldImage)
		}
	}
	recordDynamoOp(st, name, "write", 1)
	s.pers.Persist()
	respond.JSON(w, 200, out)
}

func (s *Service) updateItem(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t, name := tableAndName(st, payload)
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Table "+name+" not found")
		return
	}
	key := unmarshalMap(payload["Key"])
	if missing := missingKeyInKey(t, key); missing != "" {
		respond.ErrorJSON(w, 400, "ValidationException",
			"The provided key element does not match the schema (missing "+missing+")")
		return
	}
	existingIdx := findItemIdx(t, key)
	var oldImage map[string]any
	if existingIdx >= 0 {
		oldImage = shallowCopy(tblItems(t)[existingIdx].(map[string]any))
	}

	cond := tryCondition(payload["ConditionExpression"], oldImage,
		mapField(payload, "ExpressionAttributeNames"), mapField(payload, "ExpressionAttributeValues"))
	if cond.validation != "" {
		respond.ErrorJSON(w, 400, "ValidationException", cond.validation)
		return
	}
	if cond.failed {
		respondConditionalFailed(w, oldImage, httpapi.Str(payload, "ReturnValuesOnConditionCheckFailure"))
		return
	}

	base := shallowCopy(key)
	if oldImage != nil {
		base = shallowCopy(oldImage)
	}
	rawVals := mapField(payload, "ExpressionAttributeValues")
	jsVals := map[string]any{}
	if rawVals != nil {
		jsVals = unmarshalMap(rawVals)
	}
	result, err := applyUpdate(base, httpapi.Str(payload, "UpdateExpression"),
		mapField(payload, "ExpressionAttributeNames"), rawVals, jsVals)
	if err != nil {
		respond.ErrorJSON(w, 400, "ValidationException", err.Error())
		return
	}
	// Re-assert key attributes (REMOVE must never drop the key).
	for k, v := range key {
		result.item[k] = v
	}

	items := tblItems(t)
	if existingIdx >= 0 {
		items[existingIdx] = result.item
	} else {
		t["items"] = append(items, result.item)
	}

	recordDynamoOp(st, name, "write", 1)
	event := "INSERT"
	if oldImage != nil {
		event = "MODIFY"
	}
	s.emitStreamRecord(st, name, event, oldImage, shallowCopy(result.item))
	s.pers.Persist()

	out := map[string]any{}
	switch httpapi.Str(payload, "ReturnValues") {
	case "ALL_NEW":
		out["Attributes"] = marshalItem(result.item)
	case "ALL_OLD":
		if oldImage != nil {
			out["Attributes"] = marshalItem(oldImage)
		}
	case "UPDATED_NEW":
		out["Attributes"] = marshalItem(pickAttrs(result.item, result.changed))
	case "UPDATED_OLD":
		if oldImage != nil {
			out["Attributes"] = marshalItem(pickAttrs(oldImage, result.changed))
		}
	}
	respond.JSON(w, 200, out)
}

// ── Query / Scan ────────────────────────────────────────────────────────────

// strExpr extracts an expression field ("" when absent or not a string —
// truthiness parity for the string-only call sites).
func strExpr(payload map[string]any, key string) string {
	s, _ := payload[key].(string)
	return s
}

type queryRes struct {
	errMsg       string
	items        []any // []map[string]any post-projection
	count        int
	scannedCount int
	lastKey      map[string]any
}

// runQuery — the shared Query engine (AWS handler + UI query runner).
func (s *Service) runQuery(t map[string]any, payload map[string]any) queryRes {
	s.sweepExpired(t)
	ki := keyAttrs(t, payload["IndexName"])
	indexProj := indexProjectionAttrs(t, ki.index)
	names := mapField(payload, "ExpressionAttributeNames")
	rawVals := mapField(payload, "ExpressionAttributeValues")

	items := tblItems(t)
	var keyed []any
	if kce := strExpr(payload, "KeyConditionExpression"); kce != "" {
		for _, v := range items {
			m, _ := v.(map[string]any)
			ok, err := evaluatePredicate(kce, m, names, rawVals)
			if err != nil {
				return queryRes{errMsg: err.Error()}
			}
			if ok {
				keyed = append(keyed, v)
			}
		}
	} else {
		keyed = items
	}
	scannedCount := len(keyed)

	ordered := sortByKey(keyed, ki.pk, ki.sk)
	if v, ok := payload["ScanIndexForward"].(bool); ok && !v {
		for i, j := 0, len(ordered)-1; i < j; i, j = i+1, j-1 {
			ordered[i], ordered[j] = ordered[j], ordered[i]
		}
	}
	ordered = afterStartKey(ordered, payload["ExclusiveStartKey"], ki.pk, ki.sk)

	matched := ordered
	if fe := strExpr(payload, "FilterExpression"); fe != "" {
		matched = nil
		for _, v := range ordered {
			m, _ := v.(map[string]any)
			ok, err := evaluatePredicate(fe, m, names, rawVals)
			if err != nil {
				return queryRes{errMsg: err.Error()}
			}
			if ok {
				matched = append(matched, v)
			}
		}
	}

	limit := len(matched)
	if f, ok := httpapi.Num(payload, "Limit"); ok && f > 0 {
		limit = int(f)
	}
	if limit > len(matched) {
		limit = len(matched)
	}
	page := matched[:limit]
	more := len(matched) > limit

	resultItems := page
	if pe := strExpr(payload, "ProjectionExpression"); pe != "" {
		resultItems = make([]any, 0, len(page))
		for _, v := range page {
			m, _ := v.(map[string]any)
			projected, err := projectItem(m, pe, names)
			if err != nil {
				return queryRes{errMsg: err.Error()}
			}
			resultItems = append(resultItems, projected)
		}
	} else if indexProj != nil {
		resultItems = make([]any, 0, len(page))
		for _, v := range page {
			m, _ := v.(map[string]any)
			resultItems = append(resultItems, pickProjected(m, indexProj))
		}
	}

	var lastKey map[string]any
	if more && len(page) > 0 {
		last, _ := page[len(page)-1].(map[string]any)
		lastKey = map[string]any{ki.pk: attrVal(last, ki.pk)}
		if ki.sk != "" {
			lastKey[ki.sk] = attrVal(last, ki.sk)
		}
	}
	return queryRes{items: resultItems, count: len(page), scannedCount: scannedCount, lastKey: lastKey}
}

func tableHasIndex(t map[string]any, indexName any) bool {
	idxs, _ := t["indexes"].([]any)
	for _, v := range idxs {
		if ix, ok := v.(map[string]any); ok && jsnum.StrictEq(ix["name"], indexName) {
			return true
		}
	}
	return false
}

func (s *Service) query(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t, name := tableAndName(st, payload)
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Table "+name+" not found")
		return
	}
	if jsnum.Truthy(payload["IndexName"]) && !tableHasIndex(t, payload["IndexName"]) {
		respond.ErrorJSON(w, 400, "ValidationException",
			"The table does not have the specified index: "+jsnum.ToString(payload["IndexName"]))
		return
	}

	r := s.runQuery(t, payload)
	if r.errMsg != "" {
		respond.ErrorJSON(w, 400, "ValidationException", r.errMsg)
		return
	}
	recordDynamoOp(st, name, "read", math.Max(1, math.Ceil(float64(r.count)/2)))

	if httpapi.Str(payload, "Select") == "COUNT" {
		body := map[string]any{"Count": r.count, "ScannedCount": r.scannedCount}
		if r.lastKey != nil {
			body["LastEvaluatedKey"] = marshalItem(r.lastKey)
		}
		respond.JSON(w, 200, body)
		return
	}
	marshalled := make([]any, len(r.items))
	for i, v := range r.items {
		m, _ := v.(map[string]any)
		marshalled[i] = marshalItem(m)
	}
	body := map[string]any{
		"Items":        marshalled,
		"Count":        len(r.items),
		"ScannedCount": r.scannedCount,
	}
	if r.lastKey != nil {
		body["LastEvaluatedKey"] = marshalItem(r.lastKey)
	}
	respond.JSON(w, 200, body)
}

func (s *Service) scan(st *state.State, w http.ResponseWriter, payload map[string]any) {
	t, name := tableAndName(st, payload)
	if t == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Table "+name+" not found")
		return
	}
	if jsnum.Truthy(payload["IndexName"]) && !tableHasIndex(t, payload["IndexName"]) {
		respond.ErrorJSON(w, 400, "ValidationException",
			"The table does not have the specified index: "+jsnum.ToString(payload["IndexName"]))
		return
	}
	s.sweepExpired(t)

	ki := keyAttrs(t, payload["IndexName"])
	indexProj := indexProjectionAttrs(t, ki.index)
	names := mapField(payload, "ExpressionAttributeNames")
	rawVals := mapField(payload, "ExpressionAttributeValues")

	all := sortByKey(tblItems(t), ki.pk, ki.sk)
	scannedTotal := len(all)
	all = afterStartKey(all, payload["ExclusiveStartKey"], ki.pk, ki.sk)

	matched := all
	if fe := strExpr(payload, "FilterExpression"); fe != "" {
		matched = nil
		for _, v := range all {
			m, _ := v.(map[string]any)
			ok, err := evaluatePredicate(fe, m, names, rawVals)
			if err != nil {
				respond.ErrorJSON(w, 400, "ValidationException", err.Error())
				return
			}
			if ok {
				matched = append(matched, v)
			}
		}
	}

	limit := len(matched)
	if f, ok := httpapi.Num(payload, "Limit"); ok && f > 0 {
		limit = int(f)
	}
	if limit > len(matched) {
		limit = len(matched)
	}
	page := matched[:limit]
	more := len(matched) > limit

	recordDynamoOp(st, name, "read", math.Max(1, math.Ceil(float64(len(page))/2)))
	s.finishReadResponse(w, page, scannedTotal, payload, ki.pk, ki.sk, more, indexProj)
}

// finishReadResponse — shared Scan response shaping (Select=COUNT,
// ProjectionExpression, index projections, pagination).
func (s *Service) finishReadResponse(w http.ResponseWriter, page []any, scannedCount int,
	payload map[string]any, pk, sk string, more bool, indexProjAttrs []string) {
	if httpapi.Str(payload, "Select") == "COUNT" {
		body := map[string]any{"Count": len(page), "ScannedCount": scannedCount}
		if more && len(page) > 0 {
			last, _ := page[len(page)-1].(map[string]any)
			body["LastEvaluatedKey"] = lastKeyOf(last, pk, sk)
		}
		respond.JSON(w, 200, body)
		return
	}
	items := page
	if pe := strExpr(payload, "ProjectionExpression"); pe != "" {
		items = make([]any, 0, len(page))
		for _, v := range page {
			m, _ := v.(map[string]any)
			projected, err := projectItem(m, pe, mapField(payload, "ExpressionAttributeNames"))
			if err != nil {
				respond.ErrorJSON(w, 400, "ValidationException", err.Error())
				return
			}
			items = append(items, projected)
		}
	} else if indexProjAttrs != nil {
		items = make([]any, 0, len(page))
		for _, v := range page {
			m, _ := v.(map[string]any)
			items = append(items, pickProjected(m, indexProjAttrs))
		}
	}
	marshalled := make([]any, len(items))
	for i, v := range items {
		m, _ := v.(map[string]any)
		marshalled[i] = marshalItem(m)
	}
	body := map[string]any{
		"Items":        marshalled,
		"Count":        len(items),
		"ScannedCount": scannedCount,
	}
	if more && len(page) > 0 {
		last, _ := page[len(page)-1].(map[string]any)
		body["LastEvaluatedKey"] = lastKeyOf(last, pk, sk)
	}
	respond.JSON(w, 200, body)
}

// ── Batch ops ───────────────────────────────────────────────────────────────

func (s *Service) batchWrite(st *state.State, w http.ResponseWriter, payload map[string]any) {
	reqItems, _ := payload["RequestItems"].(map[string]any)
	for tableName, reqsAny := range reqItems {
		t := st.DynamoDB.Tables[tableName]
		if t == nil {
			continue
		}
		reqs, _ := reqsAny.([]any)
		for _, rv := range reqs {
			r, _ := rv.(map[string]any)
			if r == nil {
				continue
			}
			if put, ok := r["PutRequest"].(map[string]any); ok && put != nil {
				item, ok := unmarshal(attrValOrNil(put, "Item")).(map[string]any)
				if !ok {
					panic("Cannot read properties of undefined (reading '" + tblPK(t) + "')")
				}
				idx := findItemIdx(t, item)
				var oldImage map[string]any
				if idx >= 0 {
					oldImage = shallowCopy(tblItems(t)[idx].(map[string]any))
				}
				if idx >= 0 {
					tblItems(t)[idx] = item
				} else {
					t["items"] = append(tblItems(t), item)
				}
				recordDynamoOp(st, tableName, "write", 1)
				event := "INSERT"
				if oldImage != nil {
					event = "MODIFY"
				}
				s.emitStreamRecord(st, tableName, event, oldImage, item)
			} else if del, ok := r["DeleteRequest"].(map[string]any); ok && del != nil {
				key, ok := unmarshal(attrValOrNil(del, "Key")).(map[string]any)
				if !ok {
					panic("Cannot read properties of undefined (reading '" + tblPK(t) + "')")
				}
				// Node quirk: BatchWrite deletes match on the partition key ONLY.
				pk := tblPK(t)
				idx := -1
				for i, v := range tblItems(t) {
					m, _ := v.(map[string]any)
					if m != nil && jsnum.StrictEq(attrVal(m, pk), attrVal(key, pk)) {
						idx = i
						break
					}
				}
				if idx >= 0 {
					items := tblItems(t)
					oldImage := shallowCopy(items[idx].(map[string]any))
					t["items"] = append(items[:idx], items[idx+1:]...)
					recordDynamoOp(st, tableName, "write", 1)
					s.emitStreamRecord(st, tableName, "REMOVE", oldImage, nil)
				}
			}
		}
	}
	s.pers.Persist()
	respond.JSON(w, 200, map[string]any{"UnprocessedItems": map[string]any{}})
}

func (s *Service) batchGet(st *state.State, w http.ResponseWriter, payload map[string]any) {
	responses := map[string]any{}
	reqItems, _ := payload["RequestItems"].(map[string]any)
	for tableName, specAny := range reqItems {
		t := st.DynamoDB.Tables[tableName]
		if t == nil {
			continue
		}
		spec, _ := specAny.(map[string]any)
		keys, _ := spec["Keys"].([]any)
		pk, sk := tblPK(t), tblSK(t)
		found := []any{}
		for _, kv := range keys {
			key := unmarshalMap(kv)
			for _, v := range tblItems(t) {
				m, _ := v.(map[string]any)
				if m != nil && itemMatchesKey(m, key, pk, sk) {
					found = append(found, marshalItem(m))
					break
				}
			}
		}
		responses[tableName] = found
		if len(keys) > 0 {
			recordDynamoOp(st, tableName, "read", float64(len(keys)))
		}
	}
	respond.JSON(w, 200, map[string]any{"Responses": responses, "UnprocessedKeys": map[string]any{}})
}

// ── Transactions ────────────────────────────────────────────────────────────

func (s *Service) transactGet(st *state.State, w http.ResponseWriter, payload map[string]any) {
	responses := []any{}
	items, _ := payload["TransactItems"].([]any)
	for _, tv := range items {
		ti, _ := tv.(map[string]any)
		var g map[string]any
		if ti != nil {
			g, _ = ti["Get"].(map[string]any)
		}
		if g == nil {
			responses = append(responses, map[string]any{})
			continue
		}
		tableName := jsnum.ToString(attrVal(g, "TableName"))
		t := st.DynamoDB.Tables[tableName]
		if t == nil {
			responses = append(responses, map[string]any{})
			continue
		}
		s.sweepExpired(t)
		key := unmarshalMap(g["Key"])
		pk, sk := tblPK(t), tblSK(t)
		var item map[string]any
		for _, v := range tblItems(t) {
			m, _ := v.(map[string]any)
			if m != nil && itemMatchesKey(m, key, pk, sk) {
				item = m
				break
			}
		}
		if item != nil && jsnum.Truthy(g["ProjectionExpression"]) {
			projected, err := projectItem(item, httpapi.Str(g, "ProjectionExpression"),
				mapField(g, "ExpressionAttributeNames"))
			if err != nil {
				panic(err) // uncaught in Node → 500 boundary
			}
			item = projected
		}
		recordDynamoOp(st, tableName, "read", 1)
		if item != nil {
			responses = append(responses, map[string]any{"Item": marshalItem(item)})
		} else {
			responses = append(responses, map[string]any{})
		}
	}
	respond.JSON(w, 200, map[string]any{"Responses": responses})
}

type txResolved struct {
	kind       string
	op         map[string]any
	table      map[string]any
	tableName  string
	key        map[string]any
	newItem    map[string]any
	validation string
	existing   map[string]any
	idx        int
}

func (s *Service) transactWrite(st *state.State, w http.ResponseWriter, payload map[string]any) {
	itemsAny, isArr := payload["TransactItems"].([]any)
	if !isArr {
		itemsAny = []any{}
	}

	if len(itemsAny) == 0 {
		respond.ErrorJSON(w, 400, "ValidationException",
			"TransactItems must have length between 1 and 100")
		return
	}
	if len(itemsAny) > 100 {
		respond.ErrorJSON(w, 400, "ValidationException",
			"TransactItems must have length between 1 and 100")
		return
	}
	for _, iv := range itemsAny {
		it, _ := iv.(map[string]any)
		count := 0
		for _, k := range [...]string{"Put", "Update", "Delete", "ConditionCheck"} {
			if it != nil && jsnum.Truthy(attrVal(it, k)) {
				count++
			}
		}
		if count != 1 {
			respond.ErrorJSON(w, 400, "ValidationException",
				"TransactItems member must contain exactly one of Put, Update, Delete, or ConditionCheck")
			return
		}
	}

	// Phase 1: resolve + pre-validate against the pre-transaction snapshot.
	resolved := make([]*txResolved, 0, len(itemsAny))
	for _, iv := range itemsAny {
		it, _ := iv.(map[string]any)
		kind := ""
		var op map[string]any
		for _, k := range [...]string{"Put", "Update", "Delete", "ConditionCheck"} {
			if jsnum.Truthy(attrVal(it, k)) {
				kind = k
				op, _ = it[k].(map[string]any)
				break
			}
		}
		r := &txResolved{kind: kind, op: op, idx: -1}
		if op == nil {
			op = map[string]any{}
			r.op = op
		}
		r.tableName = jsnum.ToString(attrVal(op, "TableName"))
		table := st.DynamoDB.Tables[r.tableName]
		if table == nil {
			resolved = append(resolved, r)
			continue
		}
		r.table = table
		if kind == "Put" {
			newItem := unmarshalMap(op["Item"])
			if miss := missingKeyAttr(table, newItem); miss != "" {
				r.validation = "One or more parameter values were invalid: Missing the key " + miss + " in the item"
				resolved = append(resolved, r)
				continue
			}
			key := map[string]any{tblPK(table): attrVal(newItem, tblPK(table))}
			if sk := tblSK(table); sk != "" {
				key[sk] = attrVal(newItem, sk)
			}
			r.key = key
			r.newItem = newItem
			resolved = append(resolved, r)
			continue
		}
		key := unmarshalMap(op["Key"])
		if miss := missingKeyInKey(table, key); miss != "" {
			r.validation = "The provided key element does not match the schema (missing " + miss + ")"
			resolved = append(resolved, r)
			continue
		}
		r.key = key
		resolved = append(resolved, r)
	}

	for _, r := range resolved {
		if r.validation != "" {
			respond.ErrorJSON(w, 400, "ValidationException", r.validation)
			return
		}
		if r.table == nil {
			respond.ErrorJSON(w, 400, "ResourceNotFoundException",
				"Table "+r.tableName+" not found")
			return
		}
	}

	seen := map[string]bool{}
	for _, r := range resolved {
		id := txKeyID(r.tableName, r.table, r.key)
		if seen[id] {
			respond.ErrorJSON(w, 400, "ValidationException",
				"Transaction request cannot include multiple operations on one item")
			return
		}
		seen[id] = true
	}

	reasons := make([]any, len(resolved))
	for i := range reasons {
		reasons[i] = map[string]any{"Code": "None"}
	}
	anyFailed := false
	validationError := ""

	for i, r := range resolved {
		idx := findItemIdx(r.table, r.key)
		var existing map[string]any
		if idx >= 0 {
			existing, _ = tblItems(r.table)[idx].(map[string]any)
		}
		r.existing = existing
		r.idx = idx

		cond := tryCondition(r.op["ConditionExpression"], existing,
			mapField(r.op, "ExpressionAttributeNames"), mapField(r.op, "ExpressionAttributeValues"))
		if cond.validation != "" {
			validationError = cond.validation
			break
		}
		if cond.failed {
			anyFailed = true
			reason := map[string]any{"Code": "ConditionalCheckFailed", "Message": "The conditional request failed"}
			if httpapi.Str(r.op, "ReturnValuesOnConditionCheckFailure") == "ALL_OLD" && existing != nil {
				reason["Item"] = marshalItem(existing)
			}
			reasons[i] = reason
		}
	}

	if validationError != "" {
		respond.ErrorJSON(w, 400, "ValidationException", validationError)
		return
	}
	if anyFailed {
		respond.JSON(w, 400, map[string]any{
			"__type":              "TransactionCanceledException",
			"message":             "Transaction cancelled, please refer cancellation reasons for specific reasons",
			"CancellationReasons": reasons,
		})
		return
	}

	// Phase 2: apply. ConditionCheck items contribute no mutation.
	for _, r := range resolved {
		switch r.kind {
		case "ConditionCheck":
			continue
		case "Put":
			var oldImage map[string]any
			if r.idx >= 0 {
				oldImage = shallowCopy(tblItems(r.table)[r.idx].(map[string]any))
				tblItems(r.table)[r.idx] = r.newItem
			} else {
				r.table["items"] = append(tblItems(r.table), r.newItem)
			}
			recordDynamoOp(st, r.tableName, "write", 1)
			event := "INSERT"
			if oldImage != nil {
				event = "MODIFY"
			}
			s.emitStreamRecord(st, r.tableName, event, oldImage, r.newItem)
		case "Delete":
			if r.idx >= 0 {
				items := tblItems(r.table)
				oldImage := shallowCopy(items[r.idx].(map[string]any))
				r.table["items"] = append(items[:r.idx], items[r.idx+1:]...)
				recordDynamoOp(st, r.tableName, "write", 1)
				s.emitStreamRecord(st, r.tableName, "REMOVE", oldImage, nil)
			}
		case "Update":
			var oldImage map[string]any
			if r.idx >= 0 {
				oldImage = shallowCopy(tblItems(r.table)[r.idx].(map[string]any))
			}
			base := shallowCopy(r.key)
			if oldImage != nil {
				base = shallowCopy(oldImage)
			}
			rawVals := mapField(r.op, "ExpressionAttributeValues")
			jsVals := map[string]any{}
			if rawVals != nil {
				jsVals = unmarshalMap(rawVals)
			}
			result, err := applyUpdate(base, httpapi.Str(r.op, "UpdateExpression"),
				mapField(r.op, "ExpressionAttributeNames"), rawVals, jsVals)
			if err != nil {
				panic(err) // Node phase 2 had no try/catch → 500 boundary
			}
			for k, v := range r.key {
				result.item[k] = v
			}
			if r.idx >= 0 {
				tblItems(r.table)[r.idx] = result.item
			} else {
				r.table["items"] = append(tblItems(r.table), result.item)
			}
			recordDynamoOp(st, r.tableName, "write", 1)
			event := "INSERT"
			if oldImage != nil {
				event = "MODIFY"
			}
			s.emitStreamRecord(st, r.tableName, event, oldImage, shallowCopy(result.item))
		}
	}
	s.pers.Persist()
	respond.JSON(w, 200, map[string]any{})
}

// ── DescribeTable object ────────────────────────────────────────────────────

func describeTableObj(st *state.State, name string) map[string]any {
	t := st.DynamoDB.Tables[name]
	items := tblItems(t)
	indexes, _ := t["indexes"].([]any)

	toAwsIndex := func(ixAny any) map[string]any {
		ix, _ := ixAny.(map[string]any)
		keySchema := []any{map[string]any{"AttributeName": attrValOrNil(ix, "pk"), "KeyType": "HASH"}}
		if jsnum.Truthy(attrVal(ix, "sk")) {
			keySchema = append(keySchema, map[string]any{"AttributeName": ix["sk"], "KeyType": "RANGE"})
		}
		projection := map[string]any{"ProjectionType": "ALL"}
		if jsnum.Truthy(attrVal(ix, "projection")) {
			projection["ProjectionType"] = ix["projection"]
		}
		if jsnum.StrictEq(ix["projection"], "INCLUDE") {
			if nka, ok := ix["nonKeyAttributes"].([]any); ok && len(nka) > 0 {
				projection["NonKeyAttributes"] = nka
			}
		}
		return map[string]any{
			"IndexName":   attrValOrNil(ix, "name"),
			"KeySchema":   keySchema,
			"Projection":  projection,
			"IndexStatus": "ACTIVE",
			"ItemCount":   len(items),
		}
	}

	var gsis, lsis []any
	for _, v := range indexes {
		ix, _ := v.(map[string]any)
		if ix == nil {
			continue
		}
		if jsnum.StrictEq(ix["type"], "GSI") {
			gsis = append(gsis, toAwsIndex(v))
		} else if jsnum.StrictEq(ix["type"], "LSI") {
			lsis = append(lsis, toAwsIndex(v))
		}
	}

	tableArn := attrVal(t, "arn")
	if jsnum.Falsy(tableArn) {
		tableArn = state.Arn("dynamodb", "table/"+jsnum.ToString(attrVal(t, "name")))
	}
	created, _ := t["created"].(float64)

	keySchema := []any{map[string]any{"AttributeName": attrValOrNil(t, "pk"), "KeyType": "HASH"}}
	attrDefs := []any{map[string]any{"AttributeName": attrValOrNil(t, "pk"), "AttributeType": "S"}}
	if jsnum.Truthy(attrVal(t, "sk")) {
		keySchema = append(keySchema, map[string]any{"AttributeName": t["sk"], "KeyType": "RANGE"})
		attrDefs = append(attrDefs, map[string]any{"AttributeName": t["sk"], "AttributeType": "S"})
	}

	out := map[string]any{
		"TableName":          attrValOrNil(t, "name"),
		"TableArn":           tableArn,
		"TableStatus":        "ACTIVE",
		"ItemCount":          len(items),
		"TableSizeBytes":     jsonSizeBytes(items),
		"CreationDateTime":   created / 1000,
		"BillingModeSummary": map[string]any{"BillingMode": attrValOrNil(t, "billingMode")},
		"KeySchema":          keySchema,
		"AttributeDefinitions": attrDefs,
	}
	if len(gsis) > 0 {
		out["GlobalSecondaryIndexes"] = gsis
	}
	if len(lsis) > 0 {
		out["LocalSecondaryIndexes"] = lsis
	}
	return sanitizeMap(out)
}

func sanitizeMap(m map[string]any) map[string]any {
	out, _ := sanitizeJSON(m).(map[string]any)
	return out
}
