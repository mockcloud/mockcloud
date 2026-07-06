// Package cloudwatch — port of src/services/cloudwatch.js (awsJson1.0,
// X-Amz-Target: GraniteServiceVersion20100801.<Op>). Backs onto the metrics
// ring buffer in state (PutMetric).
package cloudwatch

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

func Handler(w http.ResponseWriter, r *httpapi.Request, st *store.Store) {
	target := r.Header.Get("x-amz-target")
	op := ""
	if i := strings.Index(target, "."); i >= 0 {
		op = target[i+1:]
	}
	b := r.ParsedBody
	switch op {
	case "PutMetricData":
		putMetricData(w, b, st)
	case "GetMetricStatistics":
		getMetricStatistics(w, b, st)
	case "ListMetrics":
		listMetrics(w, b, st)
	default:
		respond.ErrorJSON(w, 400, "UnknownOperationException", "Unknown CloudWatch op: "+op)
	}
}

func putMetricData(w http.ResponseWriter, b map[string]any, st *store.Store) {
	ns := httpapi.Str(b, "Namespace")
	st.With(func(s *state.State) {
		data, _ := b["MetricData"].([]any)
		for _, d := range data {
			dm, ok := d.(map[string]any)
			if !ok {
				continue
			}
			value, _ := httpapi.Num(dm, "Value") // Number(d.Value ?? 0)
			unit := httpapi.Str(dm, "Unit")
			if unit == "" {
				unit = "None"
			}
			s.PutMetric(ns, httpapi.Str(dm, "MetricName"), value, unit)
		}
	})
	respond.JSON(w, 200, map[string]any{})
}

// toMs — awsJson1.0 serializes timestamps as epoch seconds (number); string
// forms fall back to numeric-then-date parsing (src/services/cloudwatch.js).
func toMs(v any) int64 {
	switch t := v.(type) {
	case nil:
		return 0
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return 0
		}
		return int64(f * 1000)
	case float64:
		return int64(t * 1000)
	case string:
		if parsed, err := time.Parse(time.RFC3339, t); err == nil {
			return parsed.UnixMilli()
		}
		return 0
	}
	return 0
}

func getMetricStatistics(w http.ResponseWriter, b map[string]any, st *store.Store) {
	key := httpapi.Str(b, "Namespace") + "/" + httpapi.Str(b, "MetricName")
	start := toMs(b["StartTime"])
	end := toMs(b["EndTime"])
	if end == 0 {
		end = state.NowMs()
	}
	periodSec, ok := httpapi.Num(b, "Period")
	if !ok || periodSec == 0 {
		periodSec = 60
	}
	period := int64(periodSec) * 1000
	var stats []string
	if raw, ok := b["Statistics"].([]any); ok {
		for _, s := range raw {
			if sv, ok := s.(string); ok {
				stats = append(stats, sv)
			}
		}
	}
	if len(stats) == 0 {
		stats = []string{"Average"}
	}
	has := func(name string) bool {
		for _, s := range stats {
			if s == name {
				return true
			}
		}
		return false
	}

	type bucket struct {
		t    int64
		vals []float64
	}
	var points []state.MetricPoint
	st.With(func(s *state.State) {
		points = append(points, s.CloudWatch.Metrics[key]...)
	})
	buckets := map[int64]*bucket{}
	unit := "None"
	for _, p := range points {
		if p.T < start || p.T > end {
			continue
		}
		if p.Unit != "" {
			unit = p.Unit
		}
		bt := (p.T / period) * period
		if buckets[bt] == nil {
			buckets[bt] = &bucket{t: bt}
		}
		buckets[bt].vals = append(buckets[bt].vals, p.V)
	}
	ordered := make([]*bucket, 0, len(buckets))
	for _, bk := range buckets {
		ordered = append(ordered, bk)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].t < ordered[j].t })

	datapoints := make([]map[string]any, 0, len(ordered))
	for _, bk := range ordered {
		dp := map[string]any{"Timestamp": bk.t / 1000, "Unit": unit} // epoch seconds
		sum := 0.0
		min, max := math.Inf(1), math.Inf(-1)
		for _, v := range bk.vals {
			sum += v
			if v < min {
				min = v
			}
			if v > max {
				max = v
			}
		}
		if has("Sum") {
			dp["Sum"] = sum
		}
		if has("Average") {
			dp["Average"] = sum / float64(len(bk.vals))
		}
		if has("Minimum") {
			dp["Minimum"] = min
		}
		if has("Maximum") {
			dp["Maximum"] = max
		}
		if has("SampleCount") {
			dp["SampleCount"] = len(bk.vals)
		}
		datapoints = append(datapoints, dp)
	}
	respond.JSON(w, 200, map[string]any{"Label": httpapi.Str(b, "MetricName"), "Datapoints": datapoints})
}

func listMetrics(w http.ResponseWriter, b map[string]any, st *store.Store) {
	wantNs := httpapi.Str(b, "Namespace")
	var metrics []map[string]any
	st.With(func(s *state.State) {
		for key := range s.CloudWatch.Metrics {
			i := strings.Index(key, "/") // FIRST slash — namespaces containing '/' split here (Node quirk)
			ns, name := key[:i], key[i+1:]
			if wantNs != "" && ns != wantNs {
				continue
			}
			metrics = append(metrics, map[string]any{
				"Namespace": ns, "MetricName": name, "Dimensions": []any{},
			})
		}
	})
	sort.Slice(metrics, func(i, j int) bool {
		return metrics[i]["MetricName"].(string) < metrics[j]["MetricName"].(string)
	})
	if metrics == nil {
		metrics = []map[string]any{}
	}
	respond.JSON(w, 200, map[string]any{"Metrics": metrics})
}
