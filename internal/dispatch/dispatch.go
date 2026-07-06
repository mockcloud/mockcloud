// Package dispatch — verbatim port of src/dispatcher.js. The fall-through
// ORDER is load-bearing (e.g. SNS action check before SES, SQS after
// IAM/EC2, S3 as the unconditional default) — do not reorder.
package dispatch

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/mockcloud/mockcloud/internal/config"
	"github.com/mockcloud/mockcloud/internal/httpapi"
	"github.com/mockcloud/mockcloud/internal/protocol/respond"
	"github.com/mockcloud/mockcloud/internal/services/cloudwatch"
	"github.com/mockcloud/mockcloud/internal/services/eventbridge"
	"github.com/mockcloud/mockcloud/internal/services/lambda"
	"github.com/mockcloud/mockcloud/internal/services/logs"
	"github.com/mockcloud/mockcloud/internal/services/s3"
	"github.com/mockcloud/mockcloud/internal/services/sqs"
	"github.com/mockcloud/mockcloud/internal/state"
	"github.com/mockcloud/mockcloud/internal/store"
)

func set(items ...string) map[string]struct{} {
	m := make(map[string]struct{}, len(items))
	for _, s := range items {
		m[s] = struct{}{}
	}
	return m
}

var iamActions = set("AssumeRole", "GetCallerIdentity", "GetSessionToken", "CreateRole", "DeleteRole", "GetRole", "ListRoles", "ListRolePolicies", "ListAttachedRolePolicies", "ListRoleTags", "CreatePolicy", "AttachRolePolicy", "DetachRolePolicy", "PutRolePolicy", "DeleteRolePolicy", "CreateUser", "GetUser", "ListUsers", "DeleteUser", "CreateAccessKey", "ListInstanceProfilesForRole")
var ec2Actions = set("RunInstances", "DescribeInstances", "DescribeInstanceStatus", "DescribeInstanceAttribute", "TerminateInstances", "StopInstances", "StartInstances", "CreateSecurityGroup", "DescribeSecurityGroups", "DeleteSecurityGroup", "AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress", "RevokeSecurityGroupIngress", "RevokeSecurityGroupEgress", "CreateKeyPair", "DescribeKeyPairs", "DeleteKeyPair", "ImportKeyPair", "DescribeImages", "DescribeAvailabilityZones", "DescribeRegions", "DescribeVpcs", "DescribeSubnets", "DescribeInternetGateways", "DescribeRouteTables", "DescribeInstanceTypes", "CreateTags", "DescribeSecurityGroupRules")
var sqsActions = set("CreateQueue", "GetQueueUrl", "ListQueues", "DeleteQueue", "SendMessage", "SendMessageBatch", "ReceiveMessage", "DeleteMessage", "DeleteMessageBatch", "ChangeMessageVisibility", "ChangeMessageVisibilityBatch", "GetQueueAttributes", "SetQueueAttributes", "PurgeQueue")
var snsActions = set("CreateTopic", "DeleteTopic", "ListTopics", "Subscribe", "Unsubscribe", "Publish", "ListSubscriptions", "PublishBatch", "SetSubscriptionAttributes", "GetSubscriptionAttributes", "ListSubscriptionsByTopic", "GetTopicAttributes", "SetTopicAttributes")
var sesActions = set("SendEmail", "SendRawEmail", "VerifyEmailIdentity", "VerifyEmailAddress", "ListIdentities", "ListVerifiedEmailAddresses", "DeleteIdentity", "GetSendQuota", "GetSendStatistics", "GetIdentityVerificationAttributes")

type Dispatcher struct {
	st  *store.Store
	cfg *config.Config

	s3Svc     *s3.Service
	lambdaSvc *lambda.Service
	logsSvc   *logs.Service
}

func New(st *store.Store, cfg *config.Config, lambdaSvc *lambda.Service, s3Svc *s3.Service) *Dispatcher {
	// S3 notification delivery (fire-and-forget, outside the store lock).
	// Lambda targets work now; SQS lands in M5, SNS in M6.
	s3Svc.Deliver = func(nc state.NotifConfig, event map[string]any) {
		switch nc.Type {
		case "lambda":
			parts := strings.Split(nc.Arn, ":")
			lambdaSvc.Invoke(parts[len(parts)-1], string(respond.Marshal(event)), "s3", "")
		case "sqs": // M5
		case "sns": // M6
		}
	}
	return &Dispatcher{
		st: st, cfg: cfg,
		s3Svc:     s3Svc,
		lambdaSvc: lambdaSvc,
		logsSvc:   logs.New(st, cfg),
	}
}

// notPorted answers for services that haven't reached their milestone yet —
// JSON error shape for JSON-protocol callers, query-protocol XML otherwise.
func notPorted(w http.ResponseWriter, r *httpapi.Request, svc, milestone string) {
	msg := "MockCloud Go port: " + svc + " not yet ported (" + milestone + ")"
	if r.Header.Get("x-amz-target") != "" {
		respond.ErrorJSON(w, 400, "NotImplemented", msg)
		return
	}
	respond.ErrorXML(w, 400, "NotImplemented", msg)
}

func (d *Dispatcher) Dispatch(w http.ResponseWriter, r *httpapi.Request) {
	path := r.URL.EscapedPath()
	target := r.Header.Get("x-amz-target")
	params, _ := url.ParseQuery(string(r.RawBody))
	action := r.Query.Get("Action")
	if action == "" {
		action = params.Get("Action")
	}

	has := func(s map[string]struct{}, k string) bool { _, ok := s[k]; return ok }

	switch {
	case strings.HasPrefix(target, "AmazonEventBridge.") || strings.HasPrefix(target, "AWSEvents."):
		eventbridge.Handler(w, r, d.st)
	case strings.HasPrefix(target, "AWSStepFunctions."):
		notPorted(w, r, "Step Functions", "M7")
	case strings.HasPrefix(target, "Logs_20140328."):
		d.logsSvc.Handler(w, r)
	case strings.HasPrefix(target, "DynamoDBStreams_"):
		notPorted(w, r, "DynamoDB Streams", "M4")
	case strings.HasPrefix(target, "DynamoDB_"):
		notPorted(w, r, "DynamoDB", "M4")
	case strings.HasPrefix(target, "AWSLambda") ||
		strings.HasPrefix(path, "/2015-03-31/functions") || strings.HasPrefix(path, "/2015-03-31/event-source-mappings") ||
		strings.HasPrefix(path, "/2020-06-30/functions") || strings.HasPrefix(path, "/2020-06-30/event-source-mappings"):
		d.lambdaSvc.Handler(w, r)
	case strings.HasPrefix(target, "AmazonSimpleNotificationService") || has(snsActions, action):
		notPorted(w, r, "SNS", "M6")
	case strings.HasPrefix(target, "AmazonSimpleEmailService") || has(sesActions, action):
		notPorted(w, r, "SES", "M7")
	case strings.HasPrefix(target, "secretsmanager.") || strings.Contains(target, "SecretsManager"):
		notPorted(w, r, "Secrets Manager", "M8")
	case has(iamActions, action):
		notPorted(w, r, "IAM/STS", "M8")
	case has(ec2Actions, action):
		notPorted(w, r, "EC2", "M8")
	case has(sqsActions, action) || strings.HasPrefix(target, "AmazonSQS."):
		sqs.Handler(w, r, d.st)
	case strings.HasPrefix(target, "GraniteServiceVersion20100801."):
		cloudwatch.Handler(w, r, d.st)
	case strings.HasPrefix(path, "/model/") || strings.HasPrefix(path, "/guardrail/"):
		notPorted(w, r, "Bedrock", "M10")
	default:
		d.s3Svc.Handler(w, r)
	}
}
