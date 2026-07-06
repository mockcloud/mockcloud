// Package sns — port of src/services/sns.js: topics, subscriptions, publish
// fan-out to SQS/Lambda with FilterPolicy evaluation (exact / anything-but /
// prefix / numeric / exists over MessageAttributes or MessageBody scope),
// RawMessageDelivery, PublishBatch. Query protocol only, like Node.
//
// Fan-out is fire-and-forget (Publish returns once accepted, not delivered):
// the handler responds, then a goroutine walks the subscriptions — SQS
// enqueues re-enter the store lock, Lambda invokes never hold it.
package sns

import (
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/services/lambda"
	"github.com/mockcloud/mockcloud/internal/services/sqs"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

const account = "000000000000"

type Service struct {
	st        *store.Store
	lambdaSvc *lambda.Service
}

func New(st *store.Store, lambdaSvc *lambda.Service) *Service {
	return &Service{st: st, lambdaSvc: lambdaSvc}
}

func wrap(respTag, resultTag, inner string) string {
	return `<?xml version="1.0"?><` + respTag + ` xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><` +
		resultTag + `>` + inner + `</` + resultTag + `><ResponseMetadata><RequestId>` +
		state.RandomID(36) + `</RequestId></ResponseMetadata></` + respTag + `>`
}

func attrEntriesXML(pairs [][2]string) string {
	var sb strings.Builder
	for _, p := range pairs {
		sb.WriteString("<entry><key>" + respond.EscapeXML(p[0]) + "</key><value>" + respond.EscapeXML(p[1]) + "</value></entry>")
	}
	return sb.String()
}

func subMemberXML(s *state.Subscription, topicArn string) string {
	owner := s.Owner
	if owner == "" {
		owner = account
	}
	return "<member><SubscriptionArn>" + respond.EscapeXML(s.SubArn) + "</SubscriptionArn><Owner>" + owner +
		"</Owner><Protocol>" + respond.EscapeXML(s.Protocol) + "</Protocol><Endpoint>" + respond.EscapeXML(s.Endpoint) +
		"</Endpoint><TopicArn>" + respond.EscapeXML(topicArn) + "</TopicArn></member>"
}

func (svc *Service) Handler(w http.ResponseWriter, r *httpapi.Request) {
	params, _ := url.ParseQuery(string(r.RawBody))
	action := r.Query.Get("Action")
	if action == "" {
		action = params.Get("Action")
	}
	get := params.Get

	switch action {
	case "CreateTopic":
		name := get("Name")
		a := state.Arn("sns", name)
		svc.st.With(func(s *state.State) {
			if s.SNS.Topics[a] == nil {
				s.SNS.Topics[a] = &state.Topic{
					Name: name, Arn: a, Created: state.NowMs(),
					Subscriptions: []*state.Subscription{}, Attributes: map[string]string{},
				}
			}
		})
		respond.XML(w, 200, wrap("CreateTopicResponse", "CreateTopicResult", "<TopicArn>"+respond.EscapeXML(a)+"</TopicArn>"))

	case "DeleteTopic":
		svc.st.With(func(s *state.State) { delete(s.SNS.Topics, get("TopicArn")) })
		respond.XML(w, 200, wrap("DeleteTopicResponse", "DeleteTopicResult", ""))

	case "ListTopics":
		var arns []string
		svc.st.With(func(s *state.State) {
			for a := range s.SNS.Topics {
				arns = append(arns, a)
			}
		})
		sort.Strings(arns)
		var sb strings.Builder
		for _, a := range arns {
			sb.WriteString("<member><TopicArn>" + respond.EscapeXML(a) + "</TopicArn></member>")
		}
		respond.XML(w, 200, wrap("ListTopicsResponse", "ListTopicsResult", "<Topics>"+sb.String()+"</Topics>"))

	case "GetTopicAttributes":
		var pairs [][2]string
		var missing bool
		svc.st.With(func(s *state.State) {
			t := s.SNS.Topics[get("TopicArn")]
			if t == nil {
				missing = true
				return
			}
			pairs = [][2]string{
				{"TopicArn", t.Arn}, {"Owner", account},
				{"SubscriptionsConfirmed", strconv.Itoa(len(t.Subscriptions))},
				{"SubscriptionsPending", "0"}, {"SubscriptionsDeleted", "0"},
				{"DisplayName", t.Name},
			}
			names := make([]string, 0, len(t.Attributes))
			for n := range t.Attributes {
				names = append(names, n)
			}
			sort.Strings(names)
			for _, n := range names {
				pairs = append(pairs, [2]string{n, t.Attributes[n]})
			}
		})
		if missing {
			respond.ErrorXML(w, 404, "NotFound", "Topic not found")
			return
		}
		respond.XML(w, 200, wrap("GetTopicAttributesResponse", "GetTopicAttributesResult", "<Attributes>"+attrEntriesXML(pairs)+"</Attributes>"))

	case "SetTopicAttributes":
		var missing bool
		svc.st.With(func(s *state.State) {
			t := s.SNS.Topics[get("TopicArn")]
			if t == nil {
				missing = true
				return
			}
			if name := get("AttributeName"); name != "" {
				t.Attributes[name] = get("AttributeValue")
			}
		})
		if missing {
			respond.ErrorXML(w, 404, "NotFound", "Topic not found")
			return
		}
		respond.XML(w, 200, wrap("SetTopicAttributesResponse", "SetTopicAttributesResult", ""))

	case "Subscribe":
		topicArn := get("TopicArn")
		subArn := topicArn + ":" + state.RandomID(8)
		var missing bool
		svc.st.With(func(s *state.State) {
			t := s.SNS.Topics[topicArn]
			if t == nil {
				missing = true
				return
			}
			sub := &state.Subscription{
				SubArn: subArn, TopicArn: topicArn, Protocol: get("Protocol"),
				Endpoint: get("Endpoint"), Status: "confirmed", Owner: account,
			}
			applySubscriptionAttributes(sub, parseStringMap(params, "Attributes"))
			t.Subscriptions = append(t.Subscriptions, sub)
		})
		if missing {
			respond.ErrorXML(w, 404, "NotFound", "Topic not found")
			return
		}
		respond.XML(w, 200, wrap("SubscribeResponse", "SubscribeResult", "<SubscriptionArn>"+respond.EscapeXML(subArn)+"</SubscriptionArn>"))

	case "SetSubscriptionAttributes":
		var found bool
		svc.st.With(func(s *state.State) {
			sub := findSubscription(s, get("SubscriptionArn"))
			if sub == nil {
				return
			}
			found = true
			if name := get("AttributeName"); name != "" {
				applySubscriptionAttributes(sub, map[string]string{name: get("AttributeValue")})
			}
		})
		if !found {
			respond.ErrorXML(w, 404, "NotFound", "Subscription not found")
			return
		}
		respond.XML(w, 200, wrap("SetSubscriptionAttributesResponse", "SetSubscriptionAttributesResult", ""))

	case "GetSubscriptionAttributes":
		var pairs [][2]string
		svc.st.With(func(s *state.State) {
			sub := findSubscription(s, get("SubscriptionArn"))
			if sub == nil {
				return
			}
			owner := sub.Owner
			if owner == "" {
				owner = account
			}
			pairs = [][2]string{
				{"SubscriptionArn", sub.SubArn}, {"TopicArn", sub.TopicArn},
				{"Protocol", sub.Protocol}, {"Endpoint", sub.Endpoint}, {"Owner", owner},
				{"ConfirmationWasAuthenticated", "true"}, {"PendingConfirmation", "false"},
				{"RawMessageDelivery", boolStr(sub.RawMessageDelivery)},
			}
			if sub.FilterPolicy != nil {
				scope := sub.FilterPolicyScope
				if scope == "" {
					scope = "MessageAttributes"
				}
				pairs = append(pairs, [2]string{"FilterPolicy", *sub.FilterPolicy}, [2]string{"FilterPolicyScope", scope})
			}
		})
		if pairs == nil {
			respond.ErrorXML(w, 404, "NotFound", "Subscription not found")
			return
		}
		respond.XML(w, 200, wrap("GetSubscriptionAttributesResponse", "GetSubscriptionAttributesResult", "<Attributes>"+attrEntriesXML(pairs)+"</Attributes>"))

	case "Publish":
		topicArn := get("TopicArn")
		attributes := parseMessageAttributes(params, "MessageAttributes")
		msgID := state.RandomID(36)
		var missing bool
		svc.st.With(func(s *state.State) {
			t := s.SNS.Topics[topicArn]
			if t == nil {
				missing = true
				return
			}
			t.Published++
		})
		if missing {
			respond.ErrorXML(w, 404, "NotFound", "Topic not found")
			return
		}
		go svc.Fanout(topicArn, msgID, get("Message"), get("Subject"), attributes)
		respond.XML(w, 200, wrap("PublishResponse", "PublishResult", "<MessageId>"+msgID+"</MessageId>"))

	case "PublishBatch":
		topicArn := get("TopicArn")
		var missing bool
		svc.st.With(func(s *state.State) { missing = s.SNS.Topics[topicArn] == nil })
		if missing {
			respond.ErrorXML(w, 404, "NotFound", "Topic not found")
			return
		}
		var successXML strings.Builder
		for _, e := range parsePublishBatchEntries(params) {
			msgID := state.RandomID(36)
			svc.st.With(func(s *state.State) {
				if t := s.SNS.Topics[topicArn]; t != nil {
					t.Published++
				}
			})
			e := e
			go svc.Fanout(topicArn, msgID, e.message, e.subject, e.attributes)
			successXML.WriteString("<member><Id>" + respond.EscapeXML(e.id) + "</Id><MessageId>" + msgID + "</MessageId></member>")
		}
		respond.XML(w, 200, wrap("PublishBatchResponse", "PublishBatchResult",
			"<Successful>"+successXML.String()+"</Successful><Failed/>"))

	case "Unsubscribe":
		subArn := get("SubscriptionArn")
		svc.st.With(func(s *state.State) {
			for _, t := range s.SNS.Topics {
				var kept []*state.Subscription
				for _, sub := range t.Subscriptions {
					if sub.SubArn != subArn {
						kept = append(kept, sub)
					}
				}
				if kept == nil {
					kept = []*state.Subscription{}
				}
				t.Subscriptions = kept
			}
		})
		respond.XML(w, 200, wrap("UnsubscribeResponse", "UnsubscribeResult", ""))

	case "ListSubscriptions", "ListSubscriptionsByTopic":
		byTopic := action == "ListSubscriptionsByTopic"
		var sb strings.Builder
		var missing bool
		svc.st.With(func(s *state.State) {
			if byTopic {
				t := s.SNS.Topics[get("TopicArn")]
				if t == nil {
					missing = true
					return
				}
				for _, sub := range t.Subscriptions {
					sb.WriteString(subMemberXML(sub, t.Arn))
				}
				return
			}
			arns := make([]string, 0, len(s.SNS.Topics))
			for a := range s.SNS.Topics {
				arns = append(arns, a)
			}
			sort.Strings(arns)
			for _, a := range arns {
				t := s.SNS.Topics[a]
				for _, sub := range t.Subscriptions {
					sb.WriteString(subMemberXML(sub, t.Arn))
				}
			}
		})
		if missing {
			respond.ErrorXML(w, 404, "NotFound", "Topic not found")
			return
		}
		tag := "ListSubscriptions"
		if byTopic {
			tag = "ListSubscriptionsByTopic"
		}
		respond.XML(w, 200, wrap(tag+"Response", tag+"Result", "<Subscriptions>"+sb.String()+"</Subscriptions>"))

	default:
		respond.ErrorXML(w, 400, "InvalidAction", "Unknown action: "+action)
	}
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func applySubscriptionAttributes(sub *state.Subscription, attrs map[string]string) {
	if attrs == nil {
		return
	}
	if v, ok := attrs["FilterPolicy"]; ok {
		if v == "" {
			sub.FilterPolicy = nil
		} else {
			sub.FilterPolicy = &v
		}
	}
	if v, ok := attrs["FilterPolicyScope"]; ok {
		if v == "" {
			v = "MessageAttributes"
		}
		sub.FilterPolicyScope = v
	}
	if v, ok := attrs["RawMessageDelivery"]; ok {
		sub.RawMessageDelivery = v == "true"
	}
}

func findSubscription(s *state.State, subArn string) *state.Subscription {
	for _, t := range s.SNS.Topics {
		for _, sub := range t.Subscriptions {
			if sub.SubArn == subArn {
				return sub
			}
		}
	}
	return nil
}

// ── Fan-out (fanoutSnsMessage) ───────────────────────────────────────────────

// Fanout delivers one published message to every matching subscriber.
// Exported for EventBridge SNS targets and S3 notifications.
func (svc *Service) Fanout(topicArn, msgID, message, subject string, attributes map[string]any) {
	type delivery struct {
		sub      state.Subscription
		envelope string
	}
	var deliveries []delivery
	svc.st.With(func(s *state.State) {
		t := s.SNS.Topics[topicArn]
		if t == nil {
			return
		}
		envelope := map[string]any{
			"Type": "Notification", "MessageId": msgID, "TopicArn": t.Arn,
			"Subject": subject, "Message": message, "Timestamp": state.ISO(state.NowMs()),
		}
		if len(attributes) > 0 {
			envelope["MessageAttributes"] = toEnvelopeAttributes(attributes)
		}
		envJSON := string(respond.Marshal(envelope))
		for _, sub := range t.Subscriptions {
			if !subscriptionMatches(sub, attributes, message) {
				continue
			}
			deliveries = append(deliveries, delivery{sub: *sub, envelope: envJSON})
		}
	})

	for _, d := range deliveries {
		sub := d.sub
		switch {
		// SQS subscription — endpoint is the queue ARN.
		case sub.Protocol == "sqs" || strings.Contains(sub.Endpoint, ":sqs:"):
			qurl := sqs.QueueURLForArn(sub.Endpoint)
			svc.st.With(func(s *state.State) {
				if s.SQS.Queues[qurl] == nil {
					return
				}
				if sub.RawMessageDelivery {
					sqs.EnqueueWithAttributesLocked(s, qurl, message, attributes)
				} else {
					sqs.EnqueueJSONLocked(s, qurl, d.envelope)
				}
			})
		// Lambda subscription — endpoint is the function ARN.
		case sub.Protocol == "lambda" || strings.Contains(sub.Endpoint, ":lambda:") || strings.Contains(sub.Endpoint, ":function:"):
			parts := strings.Split(sub.Endpoint, ":")
			fnName := parts[len(parts)-1]
			var env map[string]any
			_ = json.Unmarshal([]byte(d.envelope), &env)
			event := map[string]any{"Records": []any{map[string]any{
				"EventSource": "aws:sns", "EventVersion": "1.0",
				"EventSubscriptionArn": sub.SubArn, "Sns": env,
			}}}
			go svc.lambdaSvc.Invoke(fnName, string(respond.Marshal(event)), "sns", "")
			// HTTP/HTTPS/email/SMS — accepted but not delivered (no-op).
		}
	}
}

// Internal attribute map → SNS envelope form { name: { Type, Value } }.
func toEnvelopeAttributes(attrs map[string]any) map[string]any {
	out := map[string]any{}
	for name, raw := range attrs {
		a, _ := raw.(map[string]any)
		typ, _ := a["DataType"].(string)
		if typ == "" {
			typ = "String"
		}
		value := a["BinaryValue"]
		if value == nil {
			value = a["StringValue"]
		}
		if value == nil {
			value = ""
		}
		out[name] = map[string]any{"Type": typ, "Value": value}
	}
	return out
}

// ── Query-protocol form parsers ──────────────────────────────────────────────

func parseMessageAttributes(params url.Values, prefix string) map[string]any {
	out := map[string]any{}
	for i := 1; ; i++ {
		base := prefix + ".entry." + strconv.Itoa(i)
		if _, present := params[base+".Name"]; !present {
			break
		}
		name := params.Get(base + ".Name")
		dataType := params.Get(base + ".Value.DataType")
		if dataType == "" {
			dataType = "String"
		}
		attr := map[string]any{"DataType": dataType}
		if _, hasBin := params[base+".Value.BinaryValue"]; hasBin {
			attr["BinaryValue"] = params.Get(base + ".Value.BinaryValue")
		} else {
			attr["StringValue"] = params.Get(base + ".Value.StringValue")
		}
		out[name] = attr
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func parseStringMap(params url.Values, prefix string) map[string]string {
	out := map[string]string{}
	for i := 1; ; i++ {
		base := prefix + ".entry." + strconv.Itoa(i)
		if _, present := params[base+".key"]; !present {
			break
		}
		out[params.Get(base+".key")] = params.Get(base + ".value")
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

type batchEntry struct {
	id, message, subject string
	attributes           map[string]any
}

func parsePublishBatchEntries(params url.Values) []batchEntry {
	var entries []batchEntry
	for i := 1; ; i++ {
		base := "PublishBatchRequestEntries.member." + strconv.Itoa(i)
		if _, present := params[base+".Id"]; !present {
			break
		}
		entries = append(entries, batchEntry{
			id: params.Get(base + ".Id"), message: params.Get(base + ".Message"),
			subject:    params.Get(base + ".Subject"),
			attributes: parseMessageAttributes(params, base+".MessageAttributes"),
		})
	}
	return entries
}
