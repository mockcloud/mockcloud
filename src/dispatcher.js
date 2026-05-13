// dispatcher.js — routes AWS API calls to service handlers

import { handler as s3Handler }     from './services/s3.js';
import { handler as dynamoHandler } from './services/dynamodb.js';
import { handler as lambdaHandler } from './services/lambda.js';
import { handler as snsHandler }    from './services/sns.js';
import { handler as sqsHandler }    from './services/sqs.js';
import { handler as iamHandler }    from './services/iam.js';
import { handler as ec2Handler }    from './services/ec2.js';
import { handler as smHandler }     from './services/secretsmanager.js';
import { handler as agHandler }     from './services/apigateway.js';
import { handler as kmsHandler }    from './services/kms.js';
import { handler as ssmHandler }    from './services/ssm.js';
import { handler as ebHandler }     from './services/eventbridge.js';
import { handler as ddbSHandler }   from './services/dynamodbstreams.js';
import { handler as sesHandler }    from './services/ses.js';
import { handler as sfnHandler }    from './services/stepfunctions.js';
import { handler as cognitoHandler} from './services/cognito.js';

const IAM_ACTIONS = new Set(['AssumeRole','GetCallerIdentity','GetSessionToken','CreateRole','DeleteRole','GetRole','ListRoles','CreatePolicy','AttachRolePolicy','DetachRolePolicy','CreateUser','GetUser','ListUsers','DeleteUser','CreateAccessKey']);
const EC2_ACTIONS = new Set(['RunInstances','DescribeInstances','TerminateInstances','StopInstances','StartInstances','CreateSecurityGroup','DescribeSecurityGroups','CreateKeyPair','DescribeKeyPairs','DescribeImages','DescribeAvailabilityZones','DescribeRegions']);
const SQS_ACTIONS = new Set(['CreateQueue','GetQueueUrl','ListQueues','DeleteQueue','SendMessage','ReceiveMessage','DeleteMessage','GetQueueAttributes','SetQueueAttributes','PurgeQueue']);
const SNS_ACTIONS = new Set(['CreateTopic','DeleteTopic','ListTopics','Subscribe','Unsubscribe','Publish','ListSubscriptions']);

export function dispatchAWS(req, res) {
  const url    = new URL(req.url, 'http://localhost');
  const path   = url.pathname;
  const target = req.headers['x-amz-target'] || '';
  const body   = req.rawBody || '';
  const params = new URLSearchParams(body);
  const action = url.searchParams.get('Action') || params.get('Action') || '';

  if (target.startsWith('TrentService.'))                          return kmsHandler(req, res);
  if (target.startsWith('AmazonSSM.'))                            return ssmHandler(req, res);
  if (target.startsWith('AmazonEventBridge.') || target.startsWith('AWSEvents.')) return ebHandler(req, res);
  if (target.startsWith('DynamoDBStreams_'))                      return ddbSHandler(req, res);
  if (target.startsWith('DynamoDB_'))                             return dynamoHandler(req, res);
  if (target.startsWith('AWSLambda') || path.startsWith('/2015-03-31/functions') || path.startsWith('/2015-03-31/event-source-mappings')) return lambdaHandler(req, res);
  if (target.startsWith('AmazonSimpleNotificationService') || SNS_ACTIONS.has(action)) return snsHandler(req, res);
  if (target.startsWith('AmazonSimpleEmailService') || action === 'SendEmail' || action === 'VerifyEmailIdentity' || action === 'ListIdentities' || action === 'GetSendQuota') return sesHandler(req, res);
  if (target.startsWith('secretsmanager.') || target.includes('SecretsManager')) return smHandler(req, res);
  if (target.startsWith('AWSStepFunctions.'))                     return sfnHandler(req, res);
  if (target.startsWith('AWSCognitoIdentityProviderService.'))    return cognitoHandler(req, res);
  if (IAM_ACTIONS.has(action))                                    return iamHandler(req, res);
  if (EC2_ACTIONS.has(action))                                    return ec2Handler(req, res);
  if (SQS_ACTIONS.has(action))                                    return sqsHandler(req, res);
  if (path.startsWith('/restapis'))                               return agHandler(req, res);
  return s3Handler(req, res);
}
