// Package sqs — full port of src/services/sqs.js: both protocol front-ends
// (query/XML and JSON via x-amz-target — the SDK v3 clients speak JSON, and
// the two deliberately differ: long polling and string-typed attribute
// defaults exist only on the JSON path), FIFO semantics (5-min dedupe window
// returning the ORIGINAL message, per-group ordering with in-flight group
// locking, zero-padded sequence numbers), DelaySeconds, DLQ redrive at
// receive time, and batch operations.
//
// Visibility model: lazy VisibleAt deadlines surfaced at read time replace
// Node's per-message setTimeout — observably identical (visibility is only
// ever read at select/attributes/redrive) and race-free under the store lock.
package sqs

import (
	"crypto/md5"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

const account = "000000000000"

func queueURLFor(name string) string {
	return "http://localhost:4566/" + account + "/" + name
}

// QueueURLForArn resolves an SQS ARN to its queue URL (used by EventBridge,
// SNS, S3 notifications, DDB streams).
func QueueURLForArn(arn string) string {
	if arn == "" {
		return ""
	}
	parts := strings.Split(arn, ":")
	return queueURLFor(parts[len(parts)-1])
}

func md5hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

// surfaceExpired flips messages whose lazy visibility deadline has passed —
// the read-time equivalent of Node's setTimeout callbacks firing.
func surfaceExpired(q *state.Queue) {
	now := state.NowMs()
	for _, m := range q.Messages {
		if !m.Visible && m.VisibleAt > 0 && now >= m.VisibleAt {
			m.Visible = true
			m.VisibleAt = 0
		}
	}
}

func setInvisible(m *state.Message, ms int64) {
	if ms <= 0 {
		m.Visible = true
		m.VisibleAt = 0
		return
	}
	m.Visible = false
	m.VisibleAt = state.NowMs() + ms
}

// hideMessage: bump the receive count, then hide for the visibility window.
func hideMessage(m *state.Message, ms int64) {
	m.ApproxReceiveCount++
	setInvisible(m, ms)
}

type enqueueOpts struct {
	dedupeID     string
	groupID      string
	delaySeconds float64
	attributes   map[string]any
}

// EnqueueLocked — the shared internal enqueue path (Node's enqueueMessage).
// MUST be called inside store.With. Returns the inserted message — or, on a
// FIFO dedupe hit, the ORIGINAL message (same id + sequence number) without
// enqueueing.
func EnqueueLocked(s *state.State, queueURL, body string, opts enqueueOpts) *state.Message {
	q := s.SQS.Queues[queueURL]
	if q == nil {
		return nil
	}
	var dedupePtr *string
	if opts.dedupeID != "" {
		d := opts.dedupeID
		dedupePtr = &d
	}
	msg := &state.Message{
		ID:            state.RandomID(36),
		ReceiptHandle: state.RandomID(64),
		Body:          body,
		Sent:          state.NowMs(),
		Visible:       true,
		DedupeID:      dedupePtr,
		MessageAttributes: opts.attributes,
	}

	if q.Type == "fifo" {
		// Deduplication (5-min window): explicit id, or a content hash when
		// ContentBasedDeduplication is enabled. A duplicate is a no-op that
		// returns the original message.
		dedupeKey := opts.dedupeID
		if dedupeKey == "" && q.Attributes["ContentBasedDeduplication"] == "true" {
			dedupeKey = md5hex(body)
		}
		if dedupeKey != "" {
			if q.Dedupe == nil {
				q.Dedupe = map[string]state.DedupeEntry{}
			}
			now := state.NowMs()
			for k, v := range q.Dedupe {
				if now-v.T > 300_000 {
					delete(q.Dedupe, k)
				}
			}
			if hit, ok := q.Dedupe[dedupeKey]; ok {
				return hit.Msg
			}
			q.Dedupe[dedupeKey] = state.DedupeEntry{Msg: msg, T: now}
		}
		q.Seq++
		msg.GroupID = opts.groupID
		if msg.GroupID == "" {
			msg.GroupID = "mockcloud-default"
		}
		msg.SequenceNumber = leftPad(strconv.FormatInt(q.Seq, 10), 20)
	}

	q.Messages = append(q.Messages, msg)
	if opts.delaySeconds > 0 {
		setInvisible(msg, int64(opts.delaySeconds*1000))
	}
	return msg
}

// EnqueueJSONLocked is the convenience form other services use (payload
// stringified like Node's JSON.stringify fallback).
func EnqueueJSONLocked(s *state.State, queueURL, body string) *state.Message {
	return EnqueueLocked(s, queueURL, body, enqueueOpts{})
}

func leftPad(s string, n int) string {
	for len(s) < n {
		s = "0" + s
	}
	return s
}

// selectMessages: standard queues return the earliest visible messages; FIFO
// returns sequence order, at most one per group, skipping groups with an
// in-flight message. Runs redrive first (DLQ moves happen at receive time).
func selectMessages(s *state.State, q *state.Queue, maxMsgs int) []*state.Message {
	surfaceExpired(q)
	applyRedrive(s, q)
	if q.Type != "fifo" {
		var out []*state.Message
		for _, m := range q.Messages {
			if len(out) >= maxMsgs {
				break
			}
			if m.Visible {
				out = append(out, m)
			}
		}
		return out
	}
	locked := map[string]struct{}{}
	for _, m := range q.Messages {
		if !m.Visible {
			locked[m.GroupID] = struct{}{}
		}
	}
	var chosen []*state.Message
	used := map[string]struct{}{}
	for _, m := range q.Messages {
		if len(chosen) >= maxMsgs {
			break
		}
		if !m.Visible {
			continue
		}
		if _, l := locked[m.GroupID]; l {
			continue
		}
		if _, u := used[m.GroupID]; u {
			continue
		}
		chosen = append(chosen, m)
		used[m.GroupID] = struct{}{}
	}
	return chosen
}

type redrivePolicy struct {
	arn string
	max int
}

func parseRedrive(q *state.Queue) *redrivePolicy {
	raw := q.Attributes["RedrivePolicy"]
	if raw == "" {
		return nil
	}
	var p struct {
		DeadLetterTargetArn string `json:"deadLetterTargetArn"`
		MaxReceiveCount     any    `json:"maxReceiveCount"`
	}
	if err := jsonUnmarshal(raw, &p); err != nil || p.DeadLetterTargetArn == "" || p.MaxReceiveCount == nil {
		return nil
	}
	max := 0
	switch v := p.MaxReceiveCount.(type) {
	case json.Number:
		f, _ := v.Float64()
		max = int(f)
	case float64:
		max = int(v)
	case string:
		max, _ = strconv.Atoi(v)
	}
	if max == 0 {
		return nil
	}
	return &redrivePolicy{arn: p.DeadLetterTargetArn, max: max}
}

func applyRedrive(s *state.State, q *state.Queue) {
	rd := parseRedrive(q)
	if rd == nil {
		return
	}
	dlqURL := QueueURLForArn(rd.arn)
	if dlqURL == "" || s.SQS.Queues[dlqURL] == nil {
		return
	}
	var survivors []*state.Message
	for _, m := range q.Messages {
		if m.ApproxReceiveCount >= rd.max {
			// Fresh enqueue: new id, count reset, attributes dropped (Node parity).
			EnqueueLocked(s, dlqURL, m.Body, enqueueOpts{groupID: m.GroupID})
		} else {
			survivors = append(survivors, m)
		}
	}
	q.Messages = survivors
}

func removeByHandle(q *state.Queue, handle string) bool {
	before := len(q.Messages)
	var kept []*state.Message
	for _, m := range q.Messages {
		if m.ReceiptHandle != handle {
			kept = append(kept, m)
		}
	}
	q.Messages = kept
	return len(kept) < before
}

func hasAttributes(attrs map[string]any) bool { return len(attrs) > 0 }

// md5OfMessageAttributes — AWS-canonical: sorted names, 4-byte BE length
// prefixes, value tagged String(1)/Binary(2). NOTE Node parity: BinaryValue
// arrives base64-encoded over JSON and Node hashes the UTF-8 bytes of that
// base64 TEXT (Buffer.from(str) without an encoding) — so do we.
func md5OfMessageAttributes(attrs map[string]any) string {
	enc := func(v string) []byte {
		b := []byte(v)
		out := make([]byte, 4+len(b))
		binary.BigEndian.PutUint32(out, uint32(len(b)))
		copy(out[4:], b)
		return out
	}
	names := make([]string, 0, len(attrs))
	for n := range attrs {
		names = append(names, n)
	}
	sort.Strings(names)
	var parts []byte
	for _, name := range names {
		a, _ := attrs[name].(map[string]any)
		dataType := strFrom(a, "DataType", "dataType")
		if dataType == "" {
			dataType = "String"
		}
		parts = append(parts, enc(name)...)
		parts = append(parts, enc(dataType)...)
		if bin := strFrom(a, "BinaryValue", "binaryValue"); bin != "" {
			b := []byte(bin)
			lenBuf := make([]byte, 4)
			binary.BigEndian.PutUint32(lenBuf, uint32(len(b)))
			parts = append(parts, 2)
			parts = append(parts, lenBuf...)
			parts = append(parts, b...)
		} else {
			parts = append(parts, 1)
			parts = append(parts, enc(strFrom(a, "StringValue", "stringValue"))...)
		}
	}
	sum := md5.Sum(parts)
	return hex.EncodeToString(sum[:])
}

func strFrom(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok {
			return v
		}
	}
	return ""
}

func sqsWrap(respTag, resultTag, inner string) string {
	return `<?xml version="1.0"?><` + respTag + `><` + resultTag + `>` + inner +
		`</` + resultTag + `><ResponseMetadata><RequestId>` + state.RandomID(36) +
		`</RequestId></ResponseMetadata></` + respTag + `>`
}

func batchErrorXML(id, code, message string) string {
	return `<BatchResultErrorEntry><Id>` + respond.EscapeXML(id) + `</Id><Code>` + code +
		`</Code><Message>` + respond.EscapeXML(message) + `</Message><SenderFault>true</SenderFault></BatchResultErrorEntry>`
}

// ── Handler ──────────────────────────────────────────────────────────────────

func Handler(w http.ResponseWriter, r *httpapi.Request, st *store.Store) {
	target := r.Header.Get("x-amz-target")
	if strings.HasPrefix(target, "AmazonSQS.") {
		handleJSON(w, r, st, strings.SplitN(target, ".", 2)[1], r.JSONBody())
		return
	}
	params, _ := url.ParseQuery(string(r.RawBody))
	action := r.Query.Get("Action")
	if action == "" {
		action = params.Get("Action")
	}
	handleQuery(w, r, st, action, params)
}

// ── Query/XML protocol ───────────────────────────────────────────────────────

func getBatchEntries(params url.Values, prefix string) []map[string]string {
	var entries []map[string]string
	for i := 1; ; i++ {
		base := prefix + "." + strconv.Itoa(i) + "."
		if _, ok := params[base+"Id"]; !ok {
			break
		}
		e := map[string]string{"Id": params.Get(base + "Id")}
		for _, f := range []string{"MessageBody", "ReceiptHandle", "MessageGroupId", "MessageDeduplicationId", "DelaySeconds", "VisibilityTimeout"} {
			if v, ok := params[base+f]; ok && len(v) > 0 {
				e[f] = v[0]
			}
		}
		entries = append(entries, e)
	}
	return entries
}

func handleQuery(w http.ResponseWriter, r *httpapi.Request, st *store.Store, action string, params url.Values) {
	get := params.Get
	switch action {
	case "CreateQueue":
		name := get("QueueName")
		qurl := queueURLFor(name)
		st.With(func(s *state.State) {
			if s.SQS.Queues[qurl] == nil {
				qType := "standard"
				if strings.HasSuffix(name, ".fifo") {
					qType = "fifo"
				}
				s.SQS.Queues[qurl] = &state.Queue{
					Name: name, URL: qurl, Arn: state.Arn("sqs", name), Type: qType,
					Attributes: map[string]string{}, Messages: []*state.Message{}, Created: state.NowMs(),
				}
				s.AddTrail(map[string]any{"method": "POST", "path": "/sqs/CreateQueue/" + name, "status": 200, "latency": 2})
			}
		})
		respond.XML(w, 200, sqsWrap("CreateQueueResponse", "CreateQueueResult", "<QueueUrl>"+respond.EscapeXML(qurl)+"</QueueUrl>"))

	case "GetQueueUrl":
		qurl := queueURLFor(get("QueueName"))
		if !queueExists(st, qurl) {
			respond.ErrorXML(w, 400, "AWS.SimpleQueueService.NonExistentQueue", "Queue not found")
			return
		}
		respond.XML(w, 200, sqsWrap("GetQueueUrlResponse", "GetQueueUrlResult", "<QueueUrl>"+respond.EscapeXML(qurl)+"</QueueUrl>"))

	case "ListQueues":
		var urls []string
		st.With(func(s *state.State) {
			for u := range s.SQS.Queues {
				urls = append(urls, u)
			}
		})
		sort.Strings(urls)
		var sb strings.Builder
		for _, u := range urls {
			sb.WriteString("<QueueUrl>" + respond.EscapeXML(u) + "</QueueUrl>")
		}
		respond.XML(w, 200, sqsWrap("ListQueuesResponse", "ListQueuesResult", sb.String()))

	case "DeleteQueue":
		qurl := get("QueueUrl")
		st.With(func(s *state.State) {
			q := s.SQS.Queues[qurl]
			qName := ""
			if q != nil {
				qName = q.Name
			} else {
				parts := strings.Split(qurl, "/")
				qName = parts[len(parts)-1]
			}
			delete(s.SQS.Queues, qurl)
			s.AddTrail(map[string]any{"method": "POST", "path": "/sqs/DeleteQueue/" + qName, "status": 200, "latency": 1})
		})
		respond.XML(w, 200, sqsWrap("DeleteQueueResponse", "DeleteQueueResult", ""))

	case "PurgeQueue":
		var missing bool
		st.With(func(s *state.State) {
			q := s.SQS.Queues[get("QueueUrl")]
			if q == nil {
				missing = true
				return
			}
			q.Messages = []*state.Message{}
		})
		if missing {
			respond.ErrorXML(w, 400, "AWS.SimpleQueueService.NonExistentQueue", "Queue not found")
			return
		}
		respond.XML(w, 200, sqsWrap("PurgeQueueResponse", "PurgeQueueResult", ""))

	case "SetQueueAttributes":
		var missing bool
		st.With(func(s *state.State) {
			q := s.SQS.Queues[get("QueueUrl")]
			if q == nil {
				missing = true
				return
			}
			for i := 1; ; i++ {
				n := get("Attribute." + strconv.Itoa(i) + ".Name")
				if n == "" {
					break
				}
				q.Attributes[n] = get("Attribute." + strconv.Itoa(i) + ".Value")
			}
		})
		if missing {
			respond.ErrorXML(w, 400, "AWS.SimpleQueueService.NonExistentQueue", "Queue not found")
			return
		}
		respond.XML(w, 200, sqsWrap("SetQueueAttributesResponse", "SetQueueAttributesResult", ""))

	case "SendMessage":
		qurl := get("QueueUrl")
		var missing, missingGroup bool
		var msg *state.Message
		var fifo bool
		st.With(func(s *state.State) {
			q := s.SQS.Queues[qurl]
			if q == nil {
				missing = true
				return
			}
			if q.Type == "fifo" && get("MessageGroupId") == "" {
				missingGroup = true
				return
			}
			fifo = q.Type == "fifo"
			msg = EnqueueLocked(s, qurl, get("MessageBody"), enqueueOpts{
				dedupeID: get("MessageDeduplicationId"), groupID: get("MessageGroupId"),
			})
		})
		if missing {
			respond.ErrorXML(w, 400, "AWS.SimpleQueueService.NonExistentQueue", "Queue not found")
			return
		}
		if missingGroup {
			respond.ErrorXML(w, 400, "MissingParameter", "The request must contain the parameter MessageGroupId.")
			return
		}
		seqXML := ""
		if fifo {
			seqXML = "<SequenceNumber>" + msg.SequenceNumber + "</SequenceNumber>"
		}
		respond.XML(w, 200, sqsWrap("SendMessageResponse", "SendMessageResult",
			"<MessageId>"+msg.ID+"</MessageId><MD5OfMessageBody>"+md5hex(get("MessageBody"))+"</MD5OfMessageBody>"+seqXML))

	case "SendMessageBatch":
		qurl := get("QueueUrl")
		var missing bool
		var out []string
		st.With(func(s *state.State) {
			q := s.SQS.Queues[qurl]
			if q == nil {
				missing = true
				return
			}
			for _, e := range getBatchEntries(params, "SendMessageBatchRequestEntry") {
				if q.Type == "fifo" && e["MessageGroupId"] == "" {
					out = append(out, batchErrorXML(e["Id"], "MissingParameter", "The request must contain the parameter MessageGroupId."))
					continue
				}
				delay, _ := strconv.ParseFloat(e["DelaySeconds"], 64)
				msg := EnqueueLocked(s, qurl, e["MessageBody"], enqueueOpts{
					dedupeID: e["MessageDeduplicationId"], groupID: e["MessageGroupId"], delaySeconds: delay,
				})
				seqXML := ""
				if q.Type == "fifo" {
					seqXML = "<SequenceNumber>" + msg.SequenceNumber + "</SequenceNumber>"
				}
				out = append(out, "<SendMessageBatchResultEntry><Id>"+respond.EscapeXML(e["Id"])+"</Id><MessageId>"+msg.ID+
					"</MessageId><MD5OfMessageBody>"+md5hex(e["MessageBody"])+"</MD5OfMessageBody>"+seqXML+"</SendMessageBatchResultEntry>")
			}
		})
		if missing {
			respond.ErrorXML(w, 400, "AWS.SimpleQueueService.NonExistentQueue", "Queue not found")
			return
		}
		respond.XML(w, 200, sqsWrap("SendMessageBatchResponse", "SendMessageBatchResult", strings.Join(out, "")))

	case "ReceiveMessage":
		qurl := get("QueueUrl")
		maxMsgs := intOr(get("MaxNumberOfMessages"), 1)
		visMs := int64(intOr(get("VisibilityTimeout"), 30)) * 1000
		var missing bool
		var xml strings.Builder
		st.With(func(s *state.State) {
			q := s.SQS.Queues[qurl]
			if q == nil {
				missing = true
				return
			}
			msgs := selectMessages(s, q, maxMsgs)
			for _, m := range msgs {
				hideMessage(m, visMs)
			}
			for _, m := range msgs {
				count := m.ApproxReceiveCount
				if count == 0 {
					count = 1
				}
				attrs := [][2]string{
					{"ApproximateReceiveCount", strconv.Itoa(count)},
					{"SentTimestamp", strconv.FormatInt(m.Sent, 10)},
				}
				if q.Type == "fifo" {
					attrs = append(attrs, [2]string{"MessageGroupId", m.GroupID}, [2]string{"SequenceNumber", m.SequenceNumber})
				}
				var attrXML strings.Builder
				for _, a := range attrs {
					attrXML.WriteString("<Attribute><Name>" + a[0] + "</Name><Value>" + respond.EscapeXML(a[1]) + "</Value></Attribute>")
				}
				xml.WriteString("<Message><MessageId>" + m.ID + "</MessageId><ReceiptHandle>" + m.ReceiptHandle +
					"</ReceiptHandle><Body>" + respond.EscapeXML(m.Body) + "</Body><MD5OfBody>" + md5hex(m.Body) + "</MD5OfBody>" +
					attrXML.String() + "</Message>")
			}
		})
		if missing {
			respond.ErrorXML(w, 400, "AWS.SimpleQueueService.NonExistentQueue", "Queue not found")
			return
		}
		respond.XML(w, 200, sqsWrap("ReceiveMessageResponse", "ReceiveMessageResult", xml.String()))

	case "DeleteMessage":
		st.With(func(s *state.State) {
			if q := s.SQS.Queues[get("QueueUrl")]; q != nil {
				removeByHandle(q, get("ReceiptHandle"))
			}
		})
		respond.XML(w, 200, sqsWrap("DeleteMessageResponse", "DeleteMessageResult", ""))

	case "DeleteMessageBatch":
		var missing bool
		var out []string
		st.With(func(s *state.State) {
			q := s.SQS.Queues[get("QueueUrl")]
			if q == nil {
				missing = true
				return
			}
			for _, e := range getBatchEntries(params, "DeleteMessageBatchRequestEntry") {
				if removeByHandle(q, e["ReceiptHandle"]) {
					out = append(out, "<DeleteMessageBatchResultEntry><Id>"+respond.EscapeXML(e["Id"])+"</Id></DeleteMessageBatchResultEntry>")
				} else {
					out = append(out, batchErrorXML(e["Id"], "ReceiptHandleIsInvalid", "The receipt handle does not match any message."))
				}
			}
		})
		if missing {
			respond.ErrorXML(w, 400, "AWS.SimpleQueueService.NonExistentQueue", "Queue not found")
			return
		}
		respond.XML(w, 200, sqsWrap("DeleteMessageBatchResponse", "DeleteMessageBatchResult", strings.Join(out, "")))

	case "ChangeMessageVisibility":
		var missing, badHandle bool
		st.With(func(s *state.State) {
			q := s.SQS.Queues[get("QueueUrl")]
			if q == nil {
				missing = true
				return
			}
			m := findByHandle(q, get("ReceiptHandle"))
			if m == nil {
				badHandle = true
				return
			}
			setInvisible(m, int64(intOr(get("VisibilityTimeout"), 30))*1000)
		})
		if missing {
			respond.ErrorXML(w, 400, "AWS.SimpleQueueService.NonExistentQueue", "Queue not found")
			return
		}
		if badHandle {
			respond.ErrorXML(w, 400, "ReceiptHandleIsInvalid", "The receipt handle does not match any message.")
			return
		}
		respond.XML(w, 200, sqsWrap("ChangeMessageVisibilityResponse", "ChangeMessageVisibilityResult", ""))

	case "ChangeMessageVisibilityBatch":
		var missing bool
		var out []string
		st.With(func(s *state.State) {
			q := s.SQS.Queues[get("QueueUrl")]
			if q == nil {
				missing = true
				return
			}
			for _, e := range getBatchEntries(params, "ChangeMessageVisibilityBatchRequestEntry") {
				m := findByHandle(q, e["ReceiptHandle"])
				if m == nil {
					out = append(out, batchErrorXML(e["Id"], "ReceiptHandleIsInvalid", "The receipt handle does not match any message."))
					continue
				}
				vis := 30
				if v, err := strconv.Atoi(e["VisibilityTimeout"]); err == nil && e["VisibilityTimeout"] != "" {
					vis = v
				}
				setInvisible(m, int64(vis)*1000)
				out = append(out, "<ChangeMessageVisibilityBatchResultEntry><Id>"+respond.EscapeXML(e["Id"])+"</Id></ChangeMessageVisibilityBatchResultEntry>")
			}
		})
		if missing {
			respond.ErrorXML(w, 400, "AWS.SimpleQueueService.NonExistentQueue", "Queue not found")
			return
		}
		respond.XML(w, 200, sqsWrap("ChangeMessageVisibilityBatchResponse", "ChangeMessageVisibilityBatchResult", strings.Join(out, "")))

	case "GetQueueAttributes":
		var missing bool
		var xml strings.Builder
		st.With(func(s *state.State) {
			q := s.SQS.Queues[get("QueueUrl")]
			if q == nil {
				missing = true
				return
			}
			surfaceExpired(q)
			visible, notVisible := 0, 0
			for _, m := range q.Messages {
				if m.Visible {
					visible++
				} else {
					notVisible++
				}
			}
			// XML path: raw values, no string-typed defaults (unlike JSON).
			pairs := [][2]string{
				{"QueueArn", q.Arn},
				{"ApproximateNumberOfMessages", strconv.Itoa(visible)},
				{"ApproximateNumberOfMessagesNotVisible", strconv.Itoa(notVisible)},
				{"ApproximateNumberOfMessagesDelayed", "0"},
			}
			names := make([]string, 0, len(q.Attributes))
			for n := range q.Attributes {
				names = append(names, n)
			}
			sort.Strings(names)
			for _, n := range names {
				pairs = append(pairs, [2]string{n, q.Attributes[n]})
			}
			for _, p := range pairs {
				xml.WriteString("<Attribute><Name>" + respond.EscapeXML(p[0]) + "</Name><Value>" + respond.EscapeXML(p[1]) + "</Value></Attribute>")
			}
		})
		if missing {
			respond.ErrorXML(w, 400, "AWS.SimpleQueueService.NonExistentQueue", "Queue not found")
			return
		}
		respond.XML(w, 200, sqsWrap("GetQueueAttributesResponse", "GetQueueAttributesResult", xml.String()))

	default:
		respond.ErrorXML(w, 400, "InvalidAction", "Unknown SQS action: "+action)
	}
}

func queueExists(st *store.Store, qurl string) bool {
	var ok bool
	st.With(func(s *state.State) { ok = s.SQS.Queues[qurl] != nil })
	return ok
}

func findByHandle(q *state.Queue, handle string) *state.Message {
	for _, m := range q.Messages {
		if m.ReceiptHandle == handle {
			return m
		}
	}
	return nil
}

func intOr(s string, def int) int {
	if s == "" {
		return def
	}
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}
