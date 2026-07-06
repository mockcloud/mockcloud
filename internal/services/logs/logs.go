// Package logs — port of src/services/cloudwatchlogs.js (awsJson1.1,
// X-Amz-Target: Logs_20140328.<Op>). Lambda execution logs route here under
// /aws/lambda/<fn> via PutLogEventLocked.
package logs

import (
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/mockcloud/mockcloud/internal/config"
	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

type Service struct {
	st         *store.Store
	maxStreams int // MOCKCLOUD_MAX_LOG_STREAMS, min 1
}

func New(st *store.Store, cfg *config.Config) *Service {
	max := cfg.MaxLogStreams
	if max < 1 {
		max = 1
	}
	return &Service{st: st, maxStreams: max}
}

// intField coerces a numeric JSON field (json.Number) to int64.
func intField(b map[string]any, key string) (int64, bool) {
	f, ok := httpapi.Num(b, key)
	return int64(f), ok
}

func (l *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	target := r.Header.Get("x-amz-target")
	op := ""
	if i := strings.Index(target, "."); i >= 0 {
		op = target[i+1:]
	}
	b := r.ParsedBody

	switch op {
	case "CreateLogGroup":
		name := httpapi.Str(b, "logGroupName")
		var exists bool
		l.st.With(func(s *state.State) {
			if s.Logs.Groups[name] != nil {
				exists = true
				return
			}
			ensureGroup(s, name)
		})
		if exists {
			respond.ErrorJSON(w, 400, "ResourceAlreadyExistsException", "The specified log group already exists")
			return
		}
		respond.JSON(w, 200, map[string]any{})

	case "CreateLogStream":
		group := httpapi.Str(b, "logGroupName")
		streamName := httpapi.Str(b, "logStreamName")
		var missingGroup, exists bool
		l.st.With(func(s *state.State) {
			g := s.Logs.Groups[group]
			if g == nil {
				missingGroup = true
				return
			}
			if g.Streams[streamName] != nil {
				exists = true
				return
			}
			// API-created: cap eviction must never touch it.
			ensureStream(s, group, streamName).UserCreated = true
		})
		if missingGroup {
			respond.ErrorJSON(w, 400, "ResourceNotFoundException", "The specified log group does not exist")
			return
		}
		if exists {
			respond.ErrorJSON(w, 400, "ResourceAlreadyExistsException", "The specified log stream already exists")
			return
		}
		respond.JSON(w, 200, map[string]any{})

	case "PutLogEvents":
		var missing bool
		l.st.With(func(s *state.State) {
			g := s.Logs.Groups[httpapi.Str(b, "logGroupName")]
			var stream *state.LogStream
			if g != nil {
				stream = g.Streams[httpapi.Str(b, "logStreamName")]
			}
			if stream == nil {
				missing = true
				return
			}
			events, _ := b["logEvents"].([]any)
			for _, ev := range events {
				em, ok := ev.(map[string]any)
				if !ok {
					continue
				}
				ts, _ := intField(em, "timestamp")
				stream.Events = append(stream.Events, state.LogEvent{
					Timestamp: ts, Message: httpapi.Str(em, "message"),
					IngestionTime: state.NowMs(), EventID: state.RandomID(32),
				})
			}
			sort.SliceStable(stream.Events, func(i, j int) bool {
				return stream.Events[i].Timestamp < stream.Events[j].Timestamp
			})
			if len(stream.Events) > 10000 {
				stream.Events = stream.Events[len(stream.Events)-10000:]
			}
			if len(stream.Events) > 0 {
				stream.LastEventTs = stream.Events[len(stream.Events)-1].Timestamp
			} else {
				stream.LastEventTs = 0
			}
		})
		if missing {
			respond.ErrorJSON(w, 400, "ResourceNotFoundException", "The specified log stream does not exist")
			return
		}
		respond.JSON(w, 200, map[string]any{"nextSequenceToken": state.RandomID(56)})

	case "GetLogEvents":
		l.getLogEvents(w, b)

	case "FilterLogEvents":
		l.filterLogEvents(w, b)

	case "DescribeLogGroups":
		prefix := httpapi.Str(b, "logGroupNamePrefix")
		var groups []map[string]any
		l.st.With(func(s *state.State) {
			for _, g := range s.Logs.Groups {
				if strings.HasPrefix(g.Name, prefix) {
					groups = append(groups, map[string]any{
						"logGroupName": g.Name, "arn": g.Arn, "creationTime": g.Created, "storedBytes": 0,
					})
				}
			}
		})
		sort.Slice(groups, func(i, j int) bool {
			return groups[i]["logGroupName"].(string) < groups[j]["logGroupName"].(string)
		})
		if groups == nil {
			groups = []map[string]any{}
		}
		respond.JSON(w, 200, map[string]any{"logGroups": groups})

	case "DescribeLogStreams":
		group := httpapi.Str(b, "logGroupName")
		prefix := httpapi.Str(b, "logStreamNamePrefix")
		var missing bool
		var streams []map[string]any
		l.st.With(func(s *state.State) {
			g := s.Logs.Groups[group]
			if g == nil {
				missing = true
				return
			}
			for _, st := range g.Streams {
				if strings.HasPrefix(st.Name, prefix) {
					streams = append(streams, map[string]any{
						"logStreamName": st.Name, "creationTime": st.Created,
						"lastEventTimestamp": st.LastEventTs, "storedBytes": 0,
						"arn": state.Arn("logs", "log-group:"+g.Name+":log-stream:"+st.Name),
					})
				}
			}
		})
		if missing {
			respond.ErrorJSON(w, 400, "ResourceNotFoundException", "The specified log group does not exist")
			return
		}
		sort.Slice(streams, func(i, j int) bool {
			return streams[i]["logStreamName"].(string) < streams[j]["logStreamName"].(string)
		})
		if streams == nil {
			streams = []map[string]any{}
		}
		respond.JSON(w, 200, map[string]any{"logStreams": streams})

	case "DeleteLogGroup":
		l.st.With(func(s *state.State) { delete(s.Logs.Groups, httpapi.Str(b, "logGroupName")) })
		respond.JSON(w, 200, map[string]any{})

	case "DeleteLogStream":
		l.st.With(func(s *state.State) {
			if g := s.Logs.Groups[httpapi.Str(b, "logGroupName")]; g != nil {
				delete(g.Streams, httpapi.Str(b, "logStreamName"))
			}
		})
		respond.JSON(w, 200, map[string]any{})

	default:
		respond.ErrorJSON(w, 400, "UnknownOperationException", "Unknown Logs op: "+op)
	}
}

func ensureGroup(s *state.State, name string) *state.LogGroup {
	g := s.Logs.Groups[name]
	if g == nil {
		g = &state.LogGroup{
			Name: name, Arn: state.Arn("logs", "log-group:"+name+":*"),
			Created: state.NowMs(), Streams: map[string]*state.LogStream{},
		}
		s.Logs.Groups[name] = g
	}
	return g
}

func ensureStream(s *state.State, groupName, streamName string) *state.LogStream {
	g := ensureGroup(s, groupName)
	st := g.Streams[streamName]
	if st == nil {
		st = &state.LogStream{
			Name: streamName, Created: state.NowMs(), LastEventTs: 0,
			Events: []state.LogEvent{}, Seq: s.Logs.NextStreamSeq(),
		}
		g.Streams[streamName] = st
	}
	return st
}

// ── GetLogEvents timestamp-cursor pagination ────────────────────────────────
// Tokens encode a position in the time-ordered list as '<dir>/<ts>/<k>': skip
// every event with timestamp < ts, then k events with timestamp == ts.
// Returning a token unchanged is AWS's stop signal — boundary calls echo the
// caller's token byte-identical. (Audit item 1: positional-index cursors
// looped SDK paginators forever.)

var tokenRe = regexp.MustCompile(`^([fb])/(\d+)/(\d+)$`)

type token struct {
	dir  string
	ts   int64
	skip int
}

func parseToken(tok string) *token {
	m := tokenRe.FindStringSubmatch(tok)
	if m == nil {
		return nil
	}
	var ts int64
	for _, c := range m[2] {
		ts = ts*10 + int64(c-'0')
	}
	skip := 0
	for _, c := range m[3] {
		skip = skip*10 + int(c-'0')
	}
	return &token{dir: m[1], ts: ts, skip: skip}
}

// firstAt: index of the first event with timestamp >= ts (evs is sorted).
func firstAt(evs []state.LogEvent, ts int64) int {
	i := 0
	for i < len(evs) && evs[i].Timestamp < ts {
		i++
	}
	return i
}

// tokenPos resolves a token to its boundary index; skip is clamped to the
// events actually sharing ts.
func tokenPos(evs []state.LogEvent, tok *token) int {
	i0 := firstAt(evs, tok.ts)
	i1 := i0
	for i1 < len(evs) && evs[i1].Timestamp == tok.ts {
		i1++
	}
	if p := i0 + tok.skip; p < i1 {
		return p
	}
	return i1
}

func (l *Service) getLogEvents(w http.ResponseWriter, b map[string]any) {
	var missing bool
	var evs []state.LogEvent
	l.st.With(func(s *state.State) {
		g := s.Logs.Groups[httpapi.Str(b, "logGroupName")]
		var stream *state.LogStream
		if g != nil {
			stream = g.Streams[httpapi.Str(b, "logStreamName")]
		}
		if stream == nil {
			missing = true
			return
		}
		startTime, hasStart := intField(b, "startTime")
		endTime, hasEnd := intField(b, "endTime")
		for _, e := range stream.Events {
			if hasStart && e.Timestamp < startTime {
				continue
			}
			if hasEnd && e.Timestamp >= endTime {
				continue
			}
			evs = append(evs, e)
		}
	})
	if missing {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "The specified log stream does not exist")
		return
	}

	n := len(evs)
	limit := 10000
	if v, ok := intField(b, "limit"); ok && v != 0 {
		limit = int(v)
	}
	startFromHead, _ := b["startFromHead"].(bool)
	nextToken := httpapi.Str(b, "nextToken")
	tok := parseToken(nextToken)

	var start, end int
	switch {
	case tok != nil && tok.dir == "b": // page backward to older events
		end = tokenPos(evs, tok)
		start = end - limit
		if start < 0 {
			start = 0
		}
	case tok != nil && tok.dir == "f": // page forward to newer events
		start = tokenPos(evs, tok)
		end = start + limit
		if end > n {
			end = n
		}
	case startFromHead: // first call, oldest-first
		start = 0
		end = limit
		if end > n {
			end = n
		}
	default: // first call, newest window (AWS default)
		end = n
		start = n - limit
		if start < 0 {
			start = 0
		}
	}

	page := evs[start:end]
	var fwd, bwd string
	if len(page) > 0 {
		last, first := page[len(page)-1], page[0]
		fwd = "f/" + intToStr(last.Timestamp) + "/" + intToStr(int64(end-firstAt(evs, last.Timestamp)))
		bwd = "b/" + intToStr(first.Timestamp) + "/" + intToStr(int64(start-firstAt(evs, first.Timestamp)))
	} else {
		mirrorTs, mirrorSkip := int64(0), 0
		if tok != nil {
			mirrorTs, mirrorSkip = tok.ts, tok.skip
		}
		if tok != nil && tok.dir == "f" {
			fwd = nextToken
		} else {
			fwd = "f/" + intToStr(mirrorTs) + "/" + intToStr(int64(mirrorSkip))
		}
		if tok != nil && tok.dir == "b" {
			bwd = nextToken
		} else {
			bwd = "b/" + intToStr(mirrorTs) + "/" + intToStr(int64(mirrorSkip))
		}
	}

	out := make([]map[string]any, 0, len(page))
	for _, e := range page {
		out = append(out, map[string]any{
			"timestamp": e.Timestamp, "message": e.Message, "ingestionTime": e.IngestionTime,
		})
	}
	respond.JSON(w, 200, map[string]any{
		"events": out, "nextForwardToken": fwd, "nextBackwardToken": bwd,
	})
}

func (l *Service) filterLogEvents(w http.ResponseWriter, b map[string]any) {
	group := httpapi.Str(b, "logGroupName")
	var missing bool
	type flatEvent struct {
		stream string
		ev     state.LogEvent
		seq    int64 // stream insertion order for stable cross-stream ties
		idx    int
	}
	var flat []flatEvent
	var searched []string
	l.st.With(func(s *state.State) {
		g := s.Logs.Groups[group]
		if g == nil {
			missing = true
			return
		}
		var streamNames []string
		if raw, ok := b["logStreamNames"].([]any); ok {
			for _, v := range raw {
				if sv, ok := v.(string); ok {
					streamNames = append(streamNames, sv)
				}
			}
		} else {
			for name := range g.Streams {
				streamNames = append(streamNames, name)
			}
			sort.Strings(streamNames)
		}
		searched = streamNames
		startTime, hasStart := intField(b, "startTime")
		endTime, hasEnd := intField(b, "endTime")
		pattern := httpapi.Str(b, "filterPattern")
		for _, sn := range streamNames {
			stream := g.Streams[sn]
			if stream == nil {
				continue
			}
			for i, e := range stream.Events {
				if hasStart && e.Timestamp < startTime {
					continue
				}
				if hasEnd && e.Timestamp >= endTime {
					continue
				}
				if pattern != "" && !matchFilter(pattern, e.Message) {
					continue
				}
				flat = append(flat, flatEvent{stream: sn, ev: e, seq: stream.Seq, idx: i})
			}
		}
	})
	if missing {
		respond.ErrorJSON(w, 400, "ResourceNotFoundException", "The specified log group does not exist")
		return
	}
	sort.SliceStable(flat, func(i, j int) bool { return flat[i].ev.Timestamp < flat[j].ev.Timestamp })
	events := make([]map[string]any, 0, len(flat))
	for _, f := range flat {
		events = append(events, map[string]any{
			"logStreamName": f.stream, "timestamp": f.ev.Timestamp, "message": f.ev.Message,
			"ingestionTime": f.ev.IngestionTime, "eventId": f.ev.EventID,
		})
	}
	searchedOut := make([]map[string]any, 0, len(searched))
	for _, n := range searched {
		searchedOut = append(searchedOut, map[string]any{"logStreamName": n, "searchedCompletely": true})
	}
	respond.JSON(w, 200, map[string]any{"events": events, "searchedLogStreams": searchedOut})
}

// matchFilter — minimal filter-pattern support: quoted or bare term →
// substring match.
func matchFilter(pattern, message string) bool {
	term := strings.TrimSpace(strings.Trim(pattern, `"`))
	return term == "" || strings.Contains(message, term)
}

func intToStr(v int64) string { return strconv.FormatInt(v, 10) }

// PutLogEventLocked — the internal entry point Lambda uses to stream
// execution logs (putLogEvent). MUST be called inside store.With. Evicts the
// oldest streams (by last activity, insertion order on ties) past the cap —
// never the stream just written, never API-created streams.
func PutLogEventLocked(s *state.State, maxStreams int, groupName, streamName, message string, timestamp int64) {
	if maxStreams < 1 {
		maxStreams = 1
	}
	stream := ensureStream(s, groupName, streamName)
	stream.Events = append(stream.Events, state.LogEvent{
		Timestamp: timestamp, Message: message,
		IngestionTime: state.NowMs(), EventID: state.RandomID(32),
	})
	stream.LastEventTs = timestamp
	if len(stream.Events) > 10000 {
		stream.Events = stream.Events[len(stream.Events)-10000:]
	}
	streams := s.Logs.Groups[groupName].Streams
	if len(streams) > maxStreams {
		type cand struct {
			name     string
			activity int64
			seq      int64
		}
		var oldest []cand
		for n, st := range streams {
			if n == streamName || st.UserCreated {
				continue
			}
			activity := st.LastEventTs
			if activity == 0 {
				activity = st.Created
			}
			oldest = append(oldest, cand{name: n, activity: activity, seq: st.Seq})
		}
		sort.Slice(oldest, func(i, j int) bool {
			if oldest[i].activity != oldest[j].activity {
				return oldest[i].activity < oldest[j].activity
			}
			return oldest[i].seq < oldest[j].seq
		})
		evict := len(streams) - maxStreams
		if evict > len(oldest) {
			evict = len(oldest)
		}
		for _, c := range oldest[:evict] {
			delete(streams, c.name)
		}
	}
}
