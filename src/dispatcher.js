// dispatcher.js — routes AWS API calls to service handlers

import { handler as s3Handler }     from './services/s3.js';
import { handler as dynamoHandler } from './services/dynamodb.js';
import { handler as lambdaHandler } from './services/lambda.js';
import { handler as snsHandler }    from './services/sns.js';
import { handler as sqsHandler }    from './services/sqs.js';
import { handler as iamHandler }    from './services/iam.js';
import { handler as ec2Handler }    from './services/ec2.js';
import { handler as smHandler }     from './services/secretsmanager.js';
import { handler as ebHandler }     from './services/eventbridge.js';
import { handler as ddbSHandler }   from './services/dynamodbstreams.js';
import { handler as cwHandler }     from './services/cloudwatch.js';
import { handler as logsHandler }   from './services/cloudwatchlogs.js';
import { handler as bedrockHandler } from './services/bedrock.js';
import './services/lambda-esm.js';  // side-effect: registers the SQS→Lambda poll tick

const IAM_ACTIONS = new Set(['AssumeRole','GetCallerIdentity','GetSessionToken','CreateRole','DeleteRole','GetRole','ListRoles','ListRolePolicies','ListAttachedRolePolicies','ListRoleTags','CreatePolicy','AttachRolePolicy','DetachRolePolicy','PutRolePolicy','DeleteRolePolicy','CreateUser','GetUser','ListUsers','DeleteUser','CreateAccessKey','ListInstanceProfilesForRole','GetSessionToken']);
const EC2_ACTIONS = new Set(['RunInstances','DescribeInstances','DescribeInstanceStatus','DescribeInstanceAttribute','TerminateInstances','StopInstances','StartInstances','CreateSecurityGroup','DescribeSecurityGroups','DeleteSecurityGroup','AuthorizeSecurityGroupIngress','AuthorizeSecurityGroupEgress','RevokeSecurityGroupIngress','RevokeSecurityGroupEgress','CreateKeyPair','DescribeKeyPairs','DeleteKeyPair','ImportKeyPair','DescribeImages','DescribeAvailabilityZones','DescribeRegions','DescribeVpcs','DescribeSubnets','DescribeInternetGateways','DescribeRouteTables','DescribeInstanceTypes','CreateTags','DescribeSecurityGroupRules']);
const SQS_ACTIONS = new Set(['CreateQueue','GetQueueUrl','ListQueues','DeleteQueue','SendMessage','ReceiveMessage','DeleteMessage','GetQueueAttributes','SetQueueAttributes','PurgeQueue']);
const SNS_ACTIONS = new Set(['CreateTopic','DeleteTopic','ListTopics','Subscribe','Unsubscribe','Publish','ListSubscriptions','PublishBatch','SetSubscriptionAttributes','GetSubscriptionAttributes','ListSubscriptionsByTopic','GetTopicAttributes','SetTopicAttributes']);

export function dispatchAWS(req, res) {
  const url    = new URL(req.url, 'http://localhost');
  const path   = url.pathname;
  const target = req.headers['x-amz-target'] || '';
  const body   = req.rawBody || '';
  const params = new URLSearchParams(body);
  const action = url.searchParams.get('Action') || params.get('Action') || '';

  if (target.startsWith('AmazonEventBridge.') || target.startsWith('AWSEvents.')) return ebHandler(req, res);
  if (target.startsWith('Logs_20140328.'))                        return logsHandler(req, res);
  if (target.startsWith('DynamoDBStreams_'))                      return ddbSHandler(req, res);
  if (target.startsWith('DynamoDB_'))                             return dynamoHandler(req, res);
  if (target.startsWith('AWSLambda') || path.startsWith('/2015-03-31/functions') || path.startsWith('/2015-03-31/event-source-mappings') || path.startsWith('/2020-06-30/functions') || path.startsWith('/2020-06-30/event-source-mappings')) return lambdaHandler(req, res);
  if (target.startsWith('AmazonSimpleNotificationService') || SNS_ACTIONS.has(action)) return snsHandler(req, res);
  if (target.startsWith('secretsmanager.') || target.includes('SecretsManager')) return smHandler(req, res);
  if (IAM_ACTIONS.has(action))                                    return iamHandler(req, res);
  if (EC2_ACTIONS.has(action))                                    return ec2Handler(req, res);
  if (SQS_ACTIONS.has(action) || target.startsWith('AmazonSQS.')) return sqsHandler(req, res);
  if (target.startsWith('GraniteServiceVersion20100801.'))        return cwHandler(req, res);
  if (path.startsWith('/model/') || path.startsWith('/guardrail/')) return bedrockHandler(req, res);
  return s3Handler(req, res);
}
