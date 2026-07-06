// controlplane.go — port of src/routes/dynamodb.js: the /mockcloud/dynamodb/*
// UI API (tables, items, secondary indexes, per-table metrics, query runner).
//
// Registration is callback-based so this package doesn't import
// internal/controlplane (which imports us for the reset/test hooks).
package dynamodb

import (
	"math"
	"net/http"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
)

// RegisterUIRoutes wires the /mockcloud/dynamodb/* routes through the
// caller-supplied adder (main.go bridges to controlplane.Router.Add).
func (s *Service) RegisterUIRoutes(add func(method, pattern string, h func(http.ResponseWriter, *httpapi.Request))) {
	add("GET", "/mockcloud/dynamodb/tables", s.cpListTables)
	add("GET", "/mockcloud/dynamodb/tables/:name", s.cpGetTable)
	add("POST", "/mockcloud/dynamodb/tables", s.cpCreateTable)
	add("DELETE", "/mockcloud/dynamodb/tables/:name", s.cpDeleteTable)
	add("POST", "/mockcloud/dynamodb/tables/:name/items", s.cpPutItem)
	add("DELETE", "/mockcloud/dynamodb/tables/:name/items/:pk", s.cpDeleteItem)
	add("POST", "/mockcloud/dynamodb/tables/:name/indexes", s.cpCreateIndex)
	add("DELETE", "/mockcloud/dynamodb/tables/:name/indexes/:index", s.cpDeleteIndex)
	add("GET", "/mockcloud/dynamodb/tables/:name/metrics", s.cpMetrics)
	add("POST", "/mockcloud/dynamodb/tables/:name/query", s.cpQuery)
}

func cpBody(r *httpapi.Request) map[string]any {
	if r.ParsedBody == nil {
		return map[string]any{}
	}
	return jsifyMap(r.ParsedBody)
}

func (s *Service) cpListTables(w http.ResponseWriter, r *httpapi.Request) {
	tables := []any{}
	s.st.With(func(st *state.State) {
		for _, t := range st.DynamoDB.Tables {
			tables = append(tables, map[string]any{
				"name":        attrValOrNil(t, "name"),
				"pk":          attrValOrNil(t, "pk"),
				"sk":          attrValOrNil(t, "sk"),
				"itemCount":   len(tblItems(t)),
				"billingMode": attrValOrNil(t, "billingMode"),
				"created":     attrValOrNil(t, "created"),
				"sizeBytes":   jsonSizeBytes(tblItems(t)),
			})
		}
	})
	respond.JSON(w, 200, sanitizeJSON(map[string]any{"tables": tables}))
}

func (s *Service) cpGetTable(w http.ResponseWriter, r *httpapi.Request) {
	var body map[string]any
	s.st.With(func(st *state.State) {
		t := st.DynamoDB.Tables[r.Params["name"]]
		if t == nil {
			return
		}
		body = shallowCopy(t) // { ...t, itemCount, sizeBytes }
		body["itemCount"] = len(tblItems(t))
		body["sizeBytes"] = jsonSizeBytes(tblItems(t))
	})
	if body == nil {
		respond.ErrorJSON(w, 404, "NotFound", "Table not found")
		return
	}
	respond.JSON(w, 200, sanitizeJSON(body))
}

func (s *Service) cpCreateTable(w http.ResponseWriter, r *httpapi.Request) {
	b := cpBody(r)
	nameRaw, pkRaw := attrVal(b, "name"), attrVal(b, "pk")
	if jsnum.Falsy(nameRaw) || jsnum.Falsy(pkRaw) {
		respond.ErrorJSON(w, 400, "ValidationError", "name and pk required")
		return
	}
	name := jsnum.ToString(nameRaw)
	var created map[string]any
	conflict := false
	s.st.With(func(st *state.State) {
		if st.DynamoDB.Tables[name] != nil {
			conflict = true
			return
		}
		var sk any
		if jsnum.Truthy(attrVal(b, "sk")) {
			sk = b["sk"]
		}
		billingMode := any("PAY_PER_REQUEST")
		if jsnum.Truthy(attrVal(b, "billingMode")) {
			billingMode = b["billingMode"]
		}
		t := map[string]any{
			"name": nameRaw, "pk": pkRaw, "sk": sk,
			"billingMode": billingMode,
			"items":       []any{}, "indexes": []any{},
			"created": float64(state.NowMs()),
		}
		st.DynamoDB.Tables[name] = t
		st.AddTrail(map[string]any{"method": "POST", "path": "/dynamodb/" + name, "status": 200, "latency": 3})
		created = shallowCopy(t)
		created["itemCount"] = 0
		created["sizeBytes"] = 2
	})
	if conflict {
		respond.ErrorJSON(w, 409, "Conflict", "Table already exists")
		return
	}
	s.pers.Persist()
	respond.JSON(w, 201, sanitizeJSON(created))
}

func (s *Service) cpDeleteTable(w http.ResponseWriter, r *httpapi.Request) {
	name := r.Params["name"]
	found := false
	s.st.With(func(st *state.State) {
		if st.DynamoDB.Tables[name] == nil {
			return
		}
		found = true
		delete(st.DynamoDB.Tables, name)
		st.AddTrail(map[string]any{"method": "DELETE", "path": "/dynamodb/" + name, "status": 200, "latency": 1})
	})
	if !found {
		respond.ErrorJSON(w, 404, "NotFound", "Table not found")
		return
	}
	s.pers.Persist()
	respond.JSON(w, 200, map[string]any{"deleted": name})
}

func (s *Service) cpPutItem(w http.ResponseWriter, r *httpapi.Request) {
	item := cpBody(r)
	name := r.Params["name"]
	status, code, msg := 0, "", ""
	s.st.With(func(st *state.State) {
		t := st.DynamoDB.Tables[name]
		if t == nil {
			status, code, msg = 404, "NotFound", "Table not found"
			return
		}
		pk := tblPK(t)
		if v := attrVal(item, pk); isUndefined(v) || jsnum.StrictEq(v, "") {
			status, code, msg = 400, "ValidationError", `Item must include partition key "`+pk+`"`
			return
		}
		if sk := tblSK(t); sk != "" {
			if v := attrVal(item, sk); isUndefined(v) || jsnum.StrictEq(v, "") {
				status, code, msg = 400, "ValidationError", `Item must include sort key "`+sk+`"`
				return
			}
		}
		idx := findItemIdx(t, item)
		if idx >= 0 {
			tblItems(t)[idx] = item
		} else {
			t["items"] = append(tblItems(t), item)
		}
		recordDynamoOp(st, name, "write", 1)
		st.AddTrail(map[string]any{"method": "POST", "path": "/dynamodb/" + name + "/items", "status": 200, "latency": 2})
	})
	if status != 0 {
		respond.ErrorJSON(w, status, code, msg)
		return
	}
	s.pers.Persist()
	respond.JSON(w, 200, sanitizeJSON(item))
}

func (s *Service) cpDeleteItem(w http.ResponseWriter, r *httpapi.Request) {
	name := r.Params["name"]
	pkVal := r.Params["pk"] // router already URL-decoded (Node decoded once too)
	found := false
	s.st.With(func(st *state.State) {
		t := st.DynamoDB.Tables[name]
		if t == nil {
			return
		}
		found = true
		pk := tblPK(t)
		kept := []any{}
		removed := false
		for _, v := range tblItems(t) {
			m, _ := v.(map[string]any)
			if m != nil && jsnum.ToString(attrVal(m, pk)) == pkVal {
				removed = true
				continue
			}
			kept = append(kept, v)
		}
		t["items"] = kept
		if removed {
			recordDynamoOp(st, name, "write", 1)
		}
		st.AddTrail(map[string]any{"method": "DELETE", "path": "/dynamodb/" + name + "/items/" + pkVal, "status": 200, "latency": 1})
	})
	if !found {
		respond.ErrorJSON(w, 404, "NotFound", "Table not found")
		return
	}
	s.pers.Persist()
	respond.JSON(w, 200, map[string]any{"deleted": pkVal})
}

func (s *Service) cpCreateIndex(w http.ResponseWriter, r *httpapi.Request) {
	b := cpBody(r)
	name := r.Params["name"]
	var index map[string]any
	status, code, msg := 0, "", ""
	s.st.With(func(st *state.State) {
		t := st.DynamoDB.Tables[name]
		if t == nil {
			status, code, msg = 404, "NotFound", "Table not found"
			return
		}
		ixNameRaw, pkRaw := attrVal(b, "name"), attrVal(b, "pk")
		if jsnum.Falsy(ixNameRaw) || jsnum.Falsy(pkRaw) {
			status, code, msg = 400, "ValidationError", "index name and pk required"
			return
		}
		if _, ok := t["indexes"].([]any); !ok {
			t["indexes"] = []any{}
		}
		indexes, _ := t["indexes"].([]any)
		for _, v := range indexes {
			if ix, ok := v.(map[string]any); ok && jsnum.StrictEq(ix["name"], ixNameRaw) {
				status, code, msg = 409, "Conflict", `Index "`+jsnum.ToString(ixNameRaw)+`" already exists`
				return
			}
		}
		proj := any("ALL")
		if jsnum.Truthy(attrVal(b, "projection")) {
			proj = b["projection"]
		}
		nonKey := []any{}
		if jsnum.StrictEq(proj, "INCLUDE") {
			if nka, ok := b["nonKeyAttributes"].([]any); ok {
				for _, a := range nka {
					trimmed := jsnum.Trim(jsnum.ToString(a))
					if trimmed != "" {
						nonKey = append(nonKey, trimmed)
					}
				}
			}
		}
		typ := "GSI"
		if jsnum.StrictEq(attrVal(b, "type"), "LSI") {
			typ = "LSI"
		}
		var sk any
		if jsnum.Truthy(attrVal(b, "sk")) {
			sk = b["sk"]
		}
		index = map[string]any{
			"name": ixNameRaw, "type": typ, "pk": pkRaw, "sk": sk,
			"projection": proj, "nonKeyAttributes": nonKey,
			"created": float64(state.NowMs()),
		}
		t["indexes"] = append(indexes, index)
		st.AddTrail(map[string]any{"method": "POST",
			"path": "/dynamodb/" + name + "/indexes/" + jsnum.ToString(ixNameRaw), "status": 200, "latency": 2})
	})
	if status != 0 {
		respond.ErrorJSON(w, status, code, msg)
		return
	}
	s.pers.Persist()
	respond.JSON(w, 201, sanitizeJSON(index))
}

func (s *Service) cpDeleteIndex(w http.ResponseWriter, r *httpapi.Request) {
	name := r.Params["name"]
	idxName := r.Params["index"]
	status, code, msg := 0, "", ""
	s.st.With(func(st *state.State) {
		t := st.DynamoDB.Tables[name]
		if t == nil {
			status, code, msg = 404, "NotFound", "Table not found"
			return
		}
		indexes, ok := t["indexes"].([]any)
		exists := false
		if ok {
			for _, v := range indexes {
				if ix, isMap := v.(map[string]any); isMap && jsnum.StrictEq(ix["name"], idxName) {
					exists = true
					break
				}
			}
		}
		if !exists {
			status, code, msg = 404, "NotFound", "Index not found"
			return
		}
		kept := []any{}
		for _, v := range indexes {
			if ix, isMap := v.(map[string]any); isMap && jsnum.StrictEq(ix["name"], idxName) {
				continue
			}
			kept = append(kept, v)
		}
		t["indexes"] = kept
		st.AddTrail(map[string]any{"method": "DELETE",
			"path": "/dynamodb/" + name + "/indexes/" + idxName, "status": 200, "latency": 1})
	})
	if status != 0 {
		respond.ErrorJSON(w, status, code, msg)
		return
	}
	s.pers.Persist()
	respond.JSON(w, 200, map[string]any{"deleted": idxName})
}

func (s *Service) cpMetrics(w http.ResponseWriter, r *httpapi.Request) {
	name := r.Params["name"]
	limitStr := r.Query.Get("limit")
	if limitStr == "" {
		limitStr = "30"
	}
	limit := jsnum.ParseIntPrefix(limitStr)

	var body map[string]any
	s.st.With(func(st *state.State) {
		t := st.DynamoDB.Tables[name]
		if t == nil {
			return
		}
		tName := jsnum.ToString(attrVal(t, "name"))
		series := func(metric string) []any {
			pts := st.CloudWatch.Metrics["MockCloud/DynamoDB/"+metric+"/"+tName]
			start := 0
			if !math.IsNaN(limit) {
				// .slice(-limit): negative arg → len+arg clamped, positive → min.
				arg := -limit
				if arg < 0 {
					start = len(pts) + int(arg)
					if start < 0 {
						start = 0
					}
				} else if int(arg) < len(pts) {
					start = int(arg)
				} else {
					start = len(pts)
				}
			}
			out := []any{}
			for _, p := range pts[start:] {
				out = append(out, map[string]any{"t": p.T, "v": p.V})
			}
			return out
		}
		m, _ := t["metrics"].(map[string]any)
		num := func(k string) float64 {
			if m == nil {
				return 0
			}
			f, _ := m[k].(float64)
			return f
		}
		avg := 0.0
		if num("latencyCount") != 0 {
			avg = math.Round(num("latencySum")/num("latencyCount")*100) / 100
		}
		body = map[string]any{
			"name":          attrValOrNil(t, "name"),
			"itemCount":     len(tblItems(t)),
			"sizeBytes":     jsonSizeBytes(tblItems(t)),
			"reads":         num("reads"),
			"writes":        num("writes"),
			"consumedRead":  num("consumedRead"),
			"consumedWrite": num("consumedWrite"),
			"avgLatency":    avg,
			"readCapacity":  series("ConsumedReadCapacityUnits"),
			"writeCapacity": series("ConsumedWriteCapacityUnits"),
			"latency":       series("SuccessfulRequestLatency"),
		}
	})
	if body == nil {
		respond.ErrorJSON(w, 404, "NotFound", "Table not found")
		return
	}
	respond.JSON(w, 200, sanitizeJSON(body))
}

func (s *Service) cpQuery(w http.ResponseWriter, r *httpapi.Request) {
	b := cpBody(r)
	name := r.Params["name"]

	// Marshal plain attribute values into DynamoDB descriptors so the shared
	// engine sees the SDK shape.
	ev := map[string]any{}
	if plain, ok := b["expressionAttributeValues"].(map[string]any); ok {
		for k, v := range plain {
			ev[k] = marshal(v)
		}
	}
	payload := map[string]any{}
	if jsnum.Truthy(attrVal(b, "indexName")) {
		payload["IndexName"] = b["indexName"]
	}
	if jsnum.Truthy(attrVal(b, "keyConditionExpression")) {
		payload["KeyConditionExpression"] = b["keyConditionExpression"]
	}
	if jsnum.Truthy(attrVal(b, "filterExpression")) {
		payload["FilterExpression"] = b["filterExpression"]
	}
	if jsnum.Truthy(attrVal(b, "projectionExpression")) {
		payload["ProjectionExpression"] = b["projectionExpression"]
	}
	if names, ok := b["expressionAttributeNames"].(map[string]any); ok && jsnum.Truthy(attrVal(b, "expressionAttributeNames")) {
		payload["ExpressionAttributeNames"] = names
	}
	if len(ev) > 0 {
		payload["ExpressionAttributeValues"] = ev
	}
	if f, ok := httpapi.Num(b, "limit"); ok && jsnum.Truthy(b["limit"]) && f > 0 {
		payload["Limit"] = f
	}
	if v, ok := b["scanIndexForward"].(bool); ok && !v {
		payload["ScanIndexForward"] = false
	}

	var res queryRes
	found := false
	s.st.With(func(st *state.State) {
		t := st.DynamoDB.Tables[name]
		if t == nil {
			return
		}
		found = true
		res = s.runQuery(t, payload)
		if res.errMsg == "" {
			recordDynamoOp(st, name, "read", math.Max(1, math.Ceil(float64(res.count)/2)))
		}
	})
	if !found {
		respond.ErrorJSON(w, 404, "NotFound", "Table not found")
		return
	}
	if res.errMsg != "" {
		respond.ErrorJSON(w, 400, "ValidationError", res.errMsg)
		return
	}
	items := res.items
	if items == nil {
		items = []any{}
	}
	var lastKey any
	if res.lastKey != nil {
		lastKey = res.lastKey
	}
	respond.JSON(w, 200, sanitizeJSON(map[string]any{
		"items":            items,
		"count":            res.count,
		"scannedCount":     res.scannedCount,
		"lastEvaluatedKey": lastKey,
	}))
}
