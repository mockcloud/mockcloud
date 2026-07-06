package state

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// snapshot is the export document. Struct field order = JSON key order =
// Node's insertion order: version, exportedAt, the 15 services in
// SERVICE_KEYS order, then trail.
type snapshot struct {
	Version    int   `json:"version"`
	ExportedAt int64 `json:"exportedAt"`

	S3              *S3State          `json:"s3"`
	DynamoDB        *DynamoDBState    `json:"dynamodb"`
	Lambda          *LambdaState      `json:"lambda"`
	IAM             *IAMState         `json:"iam"`
	SNS             *SNSState         `json:"sns"`
	SQS             *SQSState         `json:"sqs"`
	SecretsManager  *SecretsState     `json:"secretsmanager"`
	EC2             *EC2State         `json:"ec2"`
	EventBridge     *EventBridgeState `json:"eventbridge"`
	DynamoDBStreams *DDBStreamsState  `json:"dynamodbstreams"`
	CloudWatch      *CloudWatchState  `json:"cloudwatch"`
	Logs            *LogsState        `json:"logs"`
	Bedrock         *BedrockState     `json:"bedrock"`
	StepFunctions   *SFNState         `json:"stepfunctions"`
	SES             *SESState         `json:"ses"`

	Trail []map[string]any `json:"trail"`
}

// Export serializes the full state as Node's store.export() did: lambda
// function logs trimmed to 20, trail to 500, 2-space indentation. (Node also
// stripped _visTimer handles and FIFO dedupe Maps in the JSON replacer —
// here neither ever reaches the marshaller: visibility is a plain visibleAt
// timestamp and Queue.Dedupe is json:"-".)
func (s *State) Export() ([]byte, error) {
	lambda := &LambdaState{Functions: make(map[string]*LambdaFn, len(s.Lambda.Functions))}
	for name, fn := range s.Lambda.Functions {
		trimmed := *fn
		if len(fn.Logs) > 20 {
			trimmed.Logs = fn.Logs[:20]
		}
		lambda.Functions[name] = &trimmed
	}
	trail := s.Trail
	if len(trail) > 500 {
		trail = trail[:500]
	}
	snap := snapshot{
		Version: 1, ExportedAt: NowMs(),
		S3: s.S3, DynamoDB: s.DynamoDB, Lambda: lambda, IAM: s.IAM, SNS: s.SNS,
		SQS: s.SQS, SecretsManager: s.SecretsManager, EC2: s.EC2,
		EventBridge: s.EventBridge, DynamoDBStreams: s.DynamoDBStreams,
		CloudWatch: s.CloudWatch, Logs: s.Logs, Bedrock: s.Bedrock,
		StepFunctions: s.StepFunctions, SES: s.SES,
		Trail: trail,
	}
	// JSON.stringify(snap, replacer, 2) equivalent: 2-space indent, no HTML
	// escaping, no trailing newline.
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(snap); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// factoryJSON returns the factory default for a namespace as a JSON field map
// — the reference both for import validation (array vs object field kinds)
// and for Object.assign-style overlay.
func factoryJSON(key string) map[string]json.RawMessage {
	var v any
	switch key {
	case "s3":
		v = NewS3()
	case "dynamodb":
		v = NewDynamoDB()
	case "lambda":
		v = NewLambda()
	case "iam":
		v = NewIAM()
	case "sns":
		v = NewSNS()
	case "sqs":
		v = NewSQS()
	case "secretsmanager":
		v = NewSecrets()
	case "ec2":
		v = NewEC2()
	case "eventbridge":
		v = NewEventBridge()
	case "dynamodbstreams":
		v = NewDDBStreams()
	case "cloudwatch":
		v = NewCloudWatch()
	case "logs":
		v = NewLogs()
	case "bedrock":
		v = NewBedrock()
	case "stepfunctions":
		v = NewSFN()
	case "ses":
		v = NewSES()
	}
	b, _ := json.Marshal(v)
	var m map[string]json.RawMessage
	_ = json.Unmarshal(b, &m)
	return m
}

func jsonKind(raw json.RawMessage) byte {
	for _, c := range raw {
		switch c {
		case ' ', '\t', '\n', '\r':
			continue
		}
		return c
	}
	return 0
}

// Import restores a snapshot with Node's store.import() semantics:
//   - validate the WHOLE snapshot before touching state (present namespaces
//     must be objects; present fields type-checked against factory defaults)
//   - each present namespace: factory reset, then shallow overlay of the
//     snapshot's top-level fields (Object.assign)
//   - trail replaced (capped at TrailMax) when present as an array
//   - SQS normalization: messages arrays ensured, every message surfaced
//     (visible=true), dedupe discarded
func (s *State) Import(data []byte) error {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		return err
	}

	isNullish := func(raw json.RawMessage, ok bool) bool {
		return !ok || len(raw) == 0 || jsonKind(raw) == 'n' || string(raw) == "false" || string(raw) == "0" || string(raw) == `""`
	}

	// Pass 1: validate everything.
	for _, k := range ServiceKeys {
		raw, ok := doc[k]
		if isNullish(raw, ok) { // Node: `if (!p[k]) continue`
			continue
		}
		if jsonKind(raw) != '{' {
			return fmt.Errorf("snapshot.%s must be an object", k)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return fmt.Errorf("snapshot.%s must be an object", k)
		}
		for field, defRaw := range factoryJSON(k) {
			v, present := fields[field]
			if !present || string(v) == "null" {
				// Node checked `v === undefined` only; a literal null fails its
				// isObj/isArray checks below, so match that: null IS validated.
				if !present {
					continue
				}
			}
			switch jsonKind(defRaw) {
			case '[':
				if jsonKind(v) != '[' {
					return fmt.Errorf("snapshot.%s.%s must be an array", k, field)
				}
			case '{':
				if jsonKind(v) != '{' {
					return fmt.Errorf("snapshot.%s.%s must be an object", k, field)
				}
			}
		}
	}

	// Pass 2: apply.
	for _, k := range ServiceKeys {
		raw, ok := doc[k]
		if isNullish(raw, ok) {
			continue
		}
		if err := s.importNamespace(k, raw); err != nil {
			return err
		}
	}
	if trailRaw, ok := doc["trail"]; ok && jsonKind(trailRaw) == '[' {
		var trail []map[string]any
		if err := json.Unmarshal(trailRaw, &trail); err == nil {
			if len(trail) > s.TrailMax {
				trail = trail[:s.TrailMax]
			}
			s.Trail = trail
		}
	}

	// SQS post-import normalization (src/store.js:165-169): visibility-timer
	// state doesn't survive serialization — surface every message so it's
	// redeliverable (at-least-once), and drop the dedupe window.
	for _, q := range s.SQS.Queues {
		if q.Messages == nil {
			q.Messages = []*Message{}
		}
		q.Dedupe = nil
		for _, m := range q.Messages {
			m.Visible = true
			m.VisibleAt = 0
		}
	}
	return nil
}

// importNamespace: factory defaults + shallow field overlay, decoded into a
// fresh typed value (fresh decode ≙ Object.assign's wholesale field
// replacement; decoding into live maps would merge instead).
func (s *State) importNamespace(key string, raw json.RawMessage) error {
	merged := factoryJSON(key)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return fmt.Errorf("snapshot.%s must be an object", key)
	}
	for f, v := range fields {
		merged[f] = v
	}
	b, _ := json.Marshal(merged)

	decode := func(dst any) error {
		if err := json.Unmarshal(b, dst); err != nil {
			return fmt.Errorf("snapshot.%s: %w", key, err)
		}
		return nil
	}
	switch key {
	case "s3":
		v := new(S3State)
		if err := decode(v); err != nil {
			return err
		}
		s.S3 = v
	case "dynamodb":
		v := new(DynamoDBState)
		if err := decode(v); err != nil {
			return err
		}
		s.DynamoDB = v
	case "lambda":
		v := new(LambdaState)
		if err := decode(v); err != nil {
			return err
		}
		s.Lambda = v
	case "iam":
		v := new(IAMState)
		if err := decode(v); err != nil {
			return err
		}
		s.IAM = v
	case "sns":
		v := new(SNSState)
		if err := decode(v); err != nil {
			return err
		}
		s.SNS = v
	case "sqs":
		v := new(SQSState)
		if err := decode(v); err != nil {
			return err
		}
		s.SQS = v
	case "secretsmanager":
		v := new(SecretsState)
		if err := decode(v); err != nil {
			return err
		}
		s.SecretsManager = v
	case "ec2":
		v := new(EC2State)
		if err := decode(v); err != nil {
			return err
		}
		s.EC2 = v
	case "eventbridge":
		v := new(EventBridgeState)
		if err := decode(v); err != nil {
			return err
		}
		s.EventBridge = v
	case "dynamodbstreams":
		v := new(DDBStreamsState)
		if err := decode(v); err != nil {
			return err
		}
		s.DynamoDBStreams = v
	case "cloudwatch":
		v := new(CloudWatchState)
		if err := decode(v); err != nil {
			return err
		}
		s.CloudWatch = v
	case "logs":
		v := new(LogsState)
		if err := decode(v); err != nil {
			return err
		}
		s.Logs = v
	case "bedrock":
		v := new(BedrockState)
		if err := decode(v); err != nil {
			return err
		}
		s.Bedrock = v
	case "stepfunctions":
		v := new(SFNState)
		if err := decode(v); err != nil {
			return err
		}
		s.StepFunctions = v
	case "ses":
		v := new(SESState)
		if err := decode(v); err != nil {
			return err
		}
		s.SES = v
	}
	return nil
}
