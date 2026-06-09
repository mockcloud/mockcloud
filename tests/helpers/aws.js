// tests/helpers/aws.js
// Returns AWS SDK clients pre-wired to hit the test MockCloud instance.
// Uses dummy credentials — MockCloud doesn't validate them.

import { EC2Client } from '@aws-sdk/client-ec2';
import { S3Client } from '@aws-sdk/client-s3';

const DUMMY_CREDS = {
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  region: 'us-east-1',
};

export function makeClients(endpoint) {
  return {
    ec2: new EC2Client({ ...DUMMY_CREDS, endpoint }),
    s3:  new S3Client({ ...DUMMY_CREDS, endpoint, forcePathStyle: true }),
  };
}
