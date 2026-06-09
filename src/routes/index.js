// routes/index.js — registers all /mockcloud/* UI API routes
import { registerStatusRoutes      } from './status.js';
import { registerS3Routes          } from './s3.js';
import { registerDynamoRoutes      } from './dynamodb.js';
import { registerLambdaRoutes      } from './lambda.js';
import { registerEC2Routes         } from './ec2.js';
import { registerSNSRoutes         } from './sns.js';
import { registerSQSRoutes         } from './sqs.js';
import { registerSecretsRoutes     } from './secrets.js';
import { registerIAMRoutes         } from './iam.js';
import { registerTerminalRoutes    } from './terminal.js';
import { registerEventBridgeRoutes } from './eventbridge.js';
import { registerCloudWatchRoutes  } from './cloudwatch.js';
import { registerBedrockRoutes     } from './bedrock.js';
import { registerStepFunctionsRoutes } from './stepfunctions.js';

export function registerAllRoutes(app) {
  registerStatusRoutes(app);
  registerS3Routes(app);
  registerDynamoRoutes(app);
  registerLambdaRoutes(app);
  registerEC2Routes(app);
  registerSNSRoutes(app);
  registerSQSRoutes(app);
  registerSecretsRoutes(app);
  registerIAMRoutes(app);
  registerTerminalRoutes(app);
  registerEventBridgeRoutes(app);
  registerCloudWatchRoutes(app);
  registerBedrockRoutes(app);
  registerStepFunctionsRoutes(app);
}
