// streams.go — port of src/services/dynamodbstreams.js: stream record
// emission on item mutations (INSERT/MODIFY/REMOVE), shard buffers (capped at
// 1000), and the DynamoDBStreams_20120810.* API surface. Actual Lambda
// trigger FIRING is M6 — Service.InvokeTrigger is the settable seam (nil =
// no-op).
package dynamodb

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/jsnum"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
)

// emitStreamRecord — called (under the store lock) by every write op.
func (s *Service) emitStreamRecord(st *state.State, tableName, eventName string, oldImage, newImage map[string]any) {
	t := st.DynamoDB.Tables[tableName]
	if t == nil || !jsnum.Truthy(attrVal(t, "streamEnabled")) {
		return
	}

	streamArn := state.Arn("dynamodb",
		"table/"+tableName+"/stream/"+jsnum.ToString(attrVal(t, "streamCreated")))
	shard, _ := st.DynamoDBStreams.Shards[streamArn].([]any)

	// Keys: newImage?.[pk] || oldImage?.[pk] — JS falsy fallback included.
	keys := map[string]any{}
	if pk := attrVal(t, "pk"); jsnum.Truthy(pk) {
		pkName := jsnum.ToString(pk)
		var v any = jsnum.Undef
		if newImage != nil {
			v = attrVal(newImage, pkName)
		}
		if jsnum.Falsy(v) && oldImage != nil {
			v = attrVal(oldImage, pkName)
		}
		keys[pkName] = v
	}

	viewType := "NEW_AND_OLD_IMAGES"
	if jsnum.Truthy(attrVal(t, "streamViewType")) {
		viewType = jsnum.ToString(t["streamViewType"])
	}
	var sizeSrc any = map[string]any{}
	if newImage != nil {
		sizeSrc = newImage
	} else if oldImage != nil {
		sizeSrc = oldImage
	}

	ddb := map[string]any{
		"Keys":           keys,
		"StreamViewType": viewType,
		"SequenceNumber": jsnum.Format(float64(state.NowMs())),
		"SizeBytes":      jsonSizeBytes(sizeSrc),
	}
	// NewImage/OldImage: `x || undefined` — omitted when absent.
	if newImage != nil {
		ddb["NewImage"] = newImage
	}
	if oldImage != nil {
		ddb["OldImage"] = oldImage
	}

	record := map[string]any{
		"eventID":        state.RandomID(20),
		"eventVersion":   "1.1",
		"eventSource":    "aws:dynamodb",
		"awsRegion":      "us-east-1",
		"eventName":      eventName,
		"dynamodb":       ddb,
		"eventSourceARN": streamArn,
	}

	shard = append(shard, record)
	if len(shard) > 1000 {
		shard = shard[1:]
	}
	st.DynamoDBStreams.Shards[streamArn] = shard

	// Fire Lambda triggers outside the current turn (Node used a dynamic
	// import → async microtask; we use a goroutine off the store lock).
	triggers, _ := st.DynamoDBStreams.Triggers[tableName].([]any)
	if len(triggers) > 0 && s.InvokeTrigger != nil {
		names := make([]string, 0, len(triggers))
		for _, fn := range triggers {
			names = append(names, jsnum.ToString(fn))
		}
		event := map[string]any{"Records": []any{record}}
		go func() {
			for _, fn := range names {
				s.InvokeTrigger(fn, event)
			}
		}()
	}
}

// ── DynamoDBStreams_20120810.* API ──────────────────────────────────────────

func (s *Service) StreamsHandler(w http.ResponseWriter, r *httpapi.Request) {
	target := r.Header.Get("x-amz-target")
	b := jsifyMap(r.JSONBody())
	switch target {
	case "DynamoDBStreams_20120810.ListStreams":
		s.listStreams(w, b)
	case "DynamoDBStreams_20120810.DescribeStream":
		s.describeStream(w, b)
	case "DynamoDBStreams_20120810.GetShardIterator":
		s.getShardIterator(w, b)
	case "DynamoDBStreams_20120810.GetRecords":
		s.getRecords(w, b)
	default:
		respond.ErrorJSON(w, 400, "InvalidAction", "Unknown DynamoDB Streams action: "+target)
	}
}

func (s *Service) listStreams(w http.ResponseWriter, b map[string]any) {
	streams := []any{}
	s.st.With(func(st *state.State) {
		filter, hasFilter := b["TableName"]
		for name, t := range st.DynamoDB.Tables {
			if !jsnum.Truthy(attrVal(t, "streamEnabled")) {
				continue
			}
			if hasFilter && jsnum.Truthy(filter) && !jsnum.StrictEq(name, filter) {
				continue
			}
			label := attrVal(t, "streamCreated")
			streams = append(streams, map[string]any{
				"StreamArn":   state.Arn("dynamodb", "table/"+name+"/stream/"+jsnum.ToString(label)),
				"TableName":   name,
				"StreamLabel": label,
			})
		}
	})
	respond.JSON(w, 200, sanitizeJSON(map[string]any{"Streams": streams}))
}

func (s *Service) describeStream(w http.ResponseWriter, b map[string]any) {
	streamArn := attrVal(b, "StreamArn")
	// tableName = streamArn?.split('/')[1]
	tableName := "undefined"
	if !isUndefined(streamArn) && streamArn != nil {
		parts := strings.Split(jsnum.ToString(streamArn), "/")
		if len(parts) > 1 {
			tableName = parts[1]
		}
	}
	var body map[string]any
	s.st.With(func(st *state.State) {
		t := st.DynamoDB.Tables[tableName]
		if t == nil {
			return
		}
		viewType := "NEW_AND_OLD_IMAGES"
		if jsnum.Truthy(attrVal(t, "streamViewType")) {
			viewType = jsnum.ToString(t["streamViewType"])
		}
		body = map[string]any{
			"StreamDescription": map[string]any{
				"StreamArn":      attrValOrNil(b, "StreamArn"),
				"TableName":      tableName,
				"StreamLabel":    attrValOrNil(t, "streamCreated"),
				"StreamStatus":   "ENABLED",
				"StreamViewType": viewType,
				"Shards": []any{map[string]any{
					"ShardId":             "shardId-000000000000",
					"SequenceNumberRange": map[string]any{"StartingSequenceNumber": "000000000000"},
				}},
			},
		}
	})
	if body == nil {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "Stream not found")
		return
	}
	respond.JSON(w, 200, sanitizeJSON(body))
}

type shardIterState struct {
	StreamArn any     `json:"streamArn"`
	ShardID   any     `json:"shardId"`
	Pos       float64 `json:"pos"`
	T         int64   `json:"t"`
}

func (s *Service) getShardIterator(w http.ResponseWriter, b map[string]any) {
	st := shardIterState{
		StreamArn: attrValOrNilForJSON(b, "StreamArn"),
		ShardID:   attrValOrNilForJSON(b, "ShardId"),
		Pos:       0,
		T:         state.NowMs(),
	}
	raw, _ := json.Marshal(st)
	respond.JSON(w, 200, map[string]any{
		"ShardIterator": base64.StdEncoding.EncodeToString(raw),
	})
}

// attrValOrNilForJSON — undefined fields would be dropped by JSON.stringify;
// encoding/json can't express that, so map them to null (observably the same
// for the round-trip: shards[null-ish] matches nothing).
func attrValOrNilForJSON(m map[string]any, key string) any {
	v, ok := m[key]
	if !ok || jsnum.IsUndef(v) {
		return nil
	}
	return sanitizeJSON(v)
}

func (s *Service) getRecords(w http.ResponseWriter, b map[string]any) {
	iter, _ := b["ShardIterator"].(string)
	raw, err := base64.StdEncoding.DecodeString(iter)
	if err != nil {
		respond.ErrorJSON(w, 400, "ExpiredIteratorException", "Iterator expired")
		return
	}
	var stt map[string]any
	if err := json.Unmarshal(raw, &stt); err != nil || stt == nil {
		respond.ErrorJSON(w, 400, "ExpiredIteratorException", "Iterator expired")
		return
	}
	streamArn := jsnum.ToString(attrVal(stt, "streamArn"))
	pos := 0
	if f, ok := stt["pos"].(float64); ok {
		pos = int(f)
	}

	records := []any{}
	s.st.With(func(st *state.State) {
		shard, _ := st.DynamoDBStreams.Shards[streamArn].([]any)
		if pos < len(shard) {
			end := pos + 100
			if end > len(shard) {
				end = len(shard)
			}
			records = append(records, shard[pos:end]...)
		}
	})
	stt["pos"] = float64(pos + len(records))
	nextRaw, _ := json.Marshal(map[string]any{
		"streamArn": stt["streamArn"], "shardId": stt["shardId"], "pos": stt["pos"], "t": stt["t"],
	})
	respond.JSON(w, 200, sanitizeJSON(map[string]any{
		"Records":           records,
		"NextShardIterator": base64.StdEncoding.EncodeToString(nextRaw),
	}))
}
