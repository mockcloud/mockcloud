// Package state holds MockCloud's in-memory service state.
//
// COMPATIBILITY CONTRACT: every struct here marshals to the exact JSON the
// Node implementation produced (src/store.js INITIAL_STATE factories and the
// per-service object shapes). Field tags are load-bearing — the snapshot
// export/import format, the /mockcloud/* control plane, and the console UI
// all read these shapes. Node used mixed casing (store-native fields
// lowercase, AWS shapes PascalCase); do not "fix" it.
package state

import (
	"crypto/rand"
	"fmt"
	"time"
)

// State is the root of all service state. One instance lives behind
// store.Store's mutex.
type State struct {
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

	Trail    []map[string]any `json:"trail"`
	TrailMax int              `json:"trailMax"`
}

// ── per-service state (src/store.js INITIAL_STATE) ─────────────────────────

type S3State struct {
	Buckets map[string]*Bucket `json:"buckets"`
}

type Bucket struct {
	Name              string                    `json:"name"`
	Region            string                    `json:"region"`
	Created           int64                     `json:"created"`
	Objects           map[string]map[string]any `json:"objects"`
	ObjectVersions    map[string]any            `json:"objectVersions"`
	MultipartUploads  map[string]any            `json:"multipartUploads"`
	Website           any                       `json:"website"` // null until configured
	ACL               string                    `json:"acl"`
	PublicAccessBlock PublicAccessBlock         `json:"publicAccessBlock"`
	Versioning        string                    `json:"versioning"`
	// Set lazily by later milestones (PutBucketCors etc.) — omitted until then,
	// matching Node objects that gain the key on first write.
	CorsRules    []map[string]any `json:"corsRules,omitempty"`
	Policy       any              `json:"policy,omitempty"`
	Tagging      any              `json:"tagging,omitempty"`
	Notification any              `json:"notification,omitempty"`
}

type PublicAccessBlock struct {
	BlockPublicAcls       bool `json:"blockPublicAcls"`
	IgnorePublicAcls      bool `json:"ignorePublicAcls"`
	BlockPublicPolicy     bool `json:"blockPublicPolicy"`
	RestrictPublicBuckets bool `json:"restrictPublicBuckets"`
}

type DynamoDBState struct {
	Tables map[string]map[string]any `json:"tables"`
}

type LambdaState struct {
	Functions map[string]*LambdaFn `json:"functions"`
}

type LambdaFn struct {
	Name        string            `json:"name"`
	Runtime     string            `json:"runtime"`
	Handler     string            `json:"handler"`
	Role        string            `json:"role"`
	Memory      float64           `json:"memory"`
	Timeout     float64           `json:"timeout"`
	Env         map[string]string `json:"env"`
	Layers      []any             `json:"layers"`
	Code        string            `json:"code"`
	Invocations int64             `json:"invocations"`
	Errors      int64             `json:"errors"`
	Created     int64             `json:"created"`
	LastInvoked *int64            `json:"lastInvoked"` // null until first invoke
	Logs        []LogLine         `json:"logs"`
}

type LogLine struct {
	T     int64  `json:"t"`
	Level string `json:"level"`
	Msg   string `json:"msg"`
}

type IAMState struct {
	Users            map[string]any   `json:"users"`
	Roles            map[string]any   `json:"roles"`
	Policies         map[string]any   `json:"policies"`
	AccessKeys       map[string]string `json:"accessKeys"`
	IdentityPolicies map[string]any   `json:"identityPolicies"`
}

type SNSState struct {
	Topics map[string]any `json:"topics"`
}

type SQSState struct {
	Queues map[string]*Queue `json:"queues"`
}

type Queue struct {
	Name       string            `json:"name"`
	URL        string            `json:"url"`
	Arn        string            `json:"arn"`
	Type       string            `json:"type"` // "standard" | "fifo"
	Attributes map[string]string `json:"attributes"`
	Messages   []map[string]any  `json:"messages"`
	Created    int64             `json:"created"`
	Seq        int64             `json:"seq,omitempty"`
	// FIFO dedupe window — in-memory only, never serialized (Node stripped the
	// Map in export and deleted it on import; enqueue rebuilds it lazily).
	Dedupe map[string]any `json:"-"`
}

type SecretsState struct {
	Secrets map[string]any `json:"secrets"`
}

type EC2State struct {
	Instances      map[string]any `json:"instances"`
	KeyPairs       map[string]any `json:"keyPairs"`
	SecurityGroups map[string]any `json:"securityGroups"`
}

type EventBridgeState struct {
	Buses  map[string]*Bus  `json:"buses"`
	Events []map[string]any `json:"events"`
}

type Bus struct {
	Name  string           `json:"name"`
	Rules map[string]*Rule `json:"rules"`
}

type Rule struct {
	Name               string           `json:"Name"`
	Arn                string           `json:"Arn"`
	EventBusName       string           `json:"EventBusName"`
	ScheduleExpression *string          `json:"ScheduleExpression"`
	EventPattern       *string          `json:"EventPattern"`
	State              string           `json:"State"`
	Description        string           `json:"Description"`
	Targets            []map[string]any `json:"targets"`
	Created            int64            `json:"created"`
	NextFireAt         *int64           `json:"_nextFireAt,omitempty"`
	LastFiredAt        *int64           `json:"_lastFiredAt,omitempty"`
}

type DDBStreamsState struct {
	Shards   map[string]any `json:"shards"`
	Triggers map[string]any `json:"triggers"`
}

type CloudWatchState struct {
	Metrics   map[string][]MetricPoint `json:"metrics"`
	MaxPoints float64                  `json:"maxPoints"`
}

type MetricPoint struct {
	T    int64   `json:"t"`
	V    float64 `json:"v"`
	Unit string  `json:"unit"`
}

type LogsState struct {
	Groups map[string]*LogGroup `json:"groups"`
	// seq numbers stream creation for deterministic eviction tie-breaks
	// (Node relied on Object.keys insertion order; Go maps randomize).
	// Unexported → never serialized.
	seq int64
}

// NextStreamSeq hands out insertion-order sequence numbers for streams.
func (l *LogsState) NextStreamSeq() int64 { l.seq++; return l.seq }

type LogGroup struct {
	Name    string                `json:"name"`
	Arn     string                `json:"arn"`
	Created int64                 `json:"created"`
	Streams map[string]*LogStream `json:"streams"`
}

type LogStream struct {
	Name        string     `json:"name"`
	Created     int64      `json:"created"`
	LastEventTs int64      `json:"lastEventTs"`
	Events      []LogEvent `json:"events"`
	// Marked on CreateLogStream API calls — cap eviction skips these. Node set
	// the property only when true; omitempty matches that snapshot shape.
	UserCreated bool  `json:"userCreated,omitempty"`
	Seq         int64 `json:"-"`
}

type LogEvent struct {
	Timestamp     int64  `json:"timestamp"`
	Message       string `json:"message"`
	IngestionTime int64  `json:"ingestionTime"`
	EventID       string `json:"eventId"`
}

type BedrockState struct {
	DefaultResponse string           `json:"defaultResponse"`
	Rules           []map[string]any `json:"rules"`
	Invocations     []map[string]any `json:"invocations"`
}

type SFNState struct {
	StateMachines map[string]any `json:"stateMachines"`
	Executions    map[string]any `json:"executions"`
}

type SESState struct {
	Emails       []map[string]any `json:"emails"`
	Identities   map[string]any   `json:"identities"`
	Sent         float64          `json:"sent"`
	ReceiptRules []map[string]any `json:"receiptRules"`
}

// ── factories (must return fresh values — reset re-applies them) ────────────

// ServiceKeys in Node's SERVICE_KEYS order — the snapshot key order and the
// reset/import iteration order.
var ServiceKeys = []string{
	"s3", "dynamodb", "lambda", "iam", "sns", "sqs", "secretsmanager", "ec2",
	"eventbridge", "dynamodbstreams", "cloudwatch", "logs", "bedrock",
	"stepfunctions", "ses",
}

func NewS3() *S3State { return &S3State{Buckets: map[string]*Bucket{}} }
func NewDynamoDB() *DynamoDBState {
	return &DynamoDBState{Tables: map[string]map[string]any{}}
}
func NewLambda() *LambdaState { return &LambdaState{Functions: map[string]*LambdaFn{}} }
func NewIAM() *IAMState {
	return &IAMState{
		Users: map[string]any{}, Roles: map[string]any{}, Policies: map[string]any{},
		AccessKeys:       map[string]string{"local": "local", "test": "test"},
		IdentityPolicies: map[string]any{},
	}
}
func NewSNS() *SNSState     { return &SNSState{Topics: map[string]any{}} }
func NewSQS() *SQSState     { return &SQSState{Queues: map[string]*Queue{}} }
func NewSecrets() *SecretsState {
	return &SecretsState{Secrets: map[string]any{}}
}
func NewEC2() *EC2State {
	return &EC2State{Instances: map[string]any{}, KeyPairs: map[string]any{}, SecurityGroups: map[string]any{}}
}
func NewEventBridge() *EventBridgeState {
	return &EventBridgeState{
		Buses:  map[string]*Bus{"default": {Name: "default", Rules: map[string]*Rule{}}},
		Events: []map[string]any{},
	}
}
func NewDDBStreams() *DDBStreamsState {
	return &DDBStreamsState{Shards: map[string]any{}, Triggers: map[string]any{}}
}
func NewCloudWatch() *CloudWatchState {
	return &CloudWatchState{Metrics: map[string][]MetricPoint{}, MaxPoints: 1440}
}
func NewLogs() *LogsState { return &LogsState{Groups: map[string]*LogGroup{}} }
func NewBedrock() *BedrockState {
	return &BedrockState{
		DefaultResponse: "This is a canned MockCloud Bedrock response.",
		Rules:           []map[string]any{}, Invocations: []map[string]any{},
	}
}
func NewSFN() *SFNState {
	return &SFNState{StateMachines: map[string]any{}, Executions: map[string]any{}}
}
func NewSES() *SESState {
	return &SESState{Emails: []map[string]any{}, Identities: map[string]any{}, Sent: 0, ReceiptRules: []map[string]any{}}
}

func New() *State {
	return &State{
		S3: NewS3(), DynamoDB: NewDynamoDB(), Lambda: NewLambda(), IAM: NewIAM(),
		SNS: NewSNS(), SQS: NewSQS(), SecretsManager: NewSecrets(), EC2: NewEC2(),
		EventBridge: NewEventBridge(), DynamoDBStreams: NewDDBStreams(),
		CloudWatch: NewCloudWatch(), Logs: NewLogs(), Bedrock: NewBedrock(),
		StepFunctions: NewSFN(), SES: NewSES(),
		Trail: []map[string]any{}, TrailMax: 5000,
	}
}

// Reset re-applies the factory for one service, or everything (plus the
// trail) when service is empty. Unknown service names are a no-op, exactly
// like Node's `if (INITIAL_STATE[service])` guard.
func (s *State) Reset(service string) {
	if service != "" {
		s.resetOne(service)
		return
	}
	for _, k := range ServiceKeys {
		s.resetOne(k)
	}
	s.Trail = []map[string]any{}
}

func (s *State) resetOne(k string) {
	switch k {
	case "s3":
		s.S3 = NewS3()
	case "dynamodb":
		s.DynamoDB = NewDynamoDB()
	case "lambda":
		s.Lambda = NewLambda()
	case "iam":
		s.IAM = NewIAM()
	case "sns":
		s.SNS = NewSNS()
	case "sqs":
		s.SQS = NewSQS()
	case "secretsmanager":
		s.SecretsManager = NewSecrets()
	case "ec2":
		s.EC2 = NewEC2()
	case "eventbridge":
		s.EventBridge = NewEventBridge()
	case "dynamodbstreams":
		s.DynamoDBStreams = NewDDBStreams()
	case "cloudwatch":
		s.CloudWatch = NewCloudWatch()
	case "logs":
		s.Logs = NewLogs()
	case "bedrock":
		s.Bedrock = NewBedrock()
	case "stepfunctions":
		s.StepFunctions = NewSFN()
	case "ses":
		s.SES = NewSES()
	}
}

// AddTrail prepends a trail entry with a random id and timestamp, capped at
// TrailMax (oldest dropped).
func (s *State) AddTrail(entry map[string]any) {
	e := map[string]any{"id": RandomID(16), "t": NowMs()}
	for k, v := range entry {
		e[k] = v
	}
	s.Trail = append([]map[string]any{e}, s.Trail...)
	if len(s.Trail) > s.TrailMax {
		s.Trail = s.Trail[:s.TrailMax]
	}
}

// PutMetric appends a point to the CloudWatch ring buffer (oldest shifted
// off past MaxPoints).
func (s *State) PutMetric(namespace, metricName string, value float64, unit string) {
	if unit == "" {
		unit = "Count"
	}
	key := namespace + "/" + metricName
	pts := append(s.CloudWatch.Metrics[key], MetricPoint{T: NowMs(), V: value, Unit: unit})
	if max := int(s.CloudWatch.MaxPoints); max > 0 && len(pts) > max {
		pts = pts[len(pts)-max:]
	}
	s.CloudWatch.Metrics[key] = pts
}

// ── shared helpers (src/store.js) ───────────────────────────────────────────

func NowMs() int64 { return time.Now().UnixMilli() }

// RandomID returns n random lowercase-hex characters (Node's randomId).
func RandomID(n int) string {
	b := make([]byte, (n+1)/2)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)[:n]
}

func Arn(service, resource string) string {
	return fmt.Sprintf("arn:aws:%s:us-east-1:000000000000:%s", service, resource)
}

// IamArn — IAM ARNs are global (empty region segment).
func IamArn(resource string) string {
	return "arn:aws:iam::000000000000:" + resource
}

// ISO returns a JS Date.toISOString()-compatible timestamp (UTC, ms).
func ISO(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}
