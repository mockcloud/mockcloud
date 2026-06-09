// tests/helpers/test-env.js
// MUST be imported BEFORE any src/ module that captures a storage-root env var
// at load time (s3.js → S3_ROOT, dynamodb/persistence.js → DDB_ROOT). ESM
// evaluates imports depth-first in source order, so importing this module first
// in server.js guarantees these are set before those consts are read.
import os from 'os';
import path from 'path';

export const TEST_S3_ROOT  = path.join(os.tmpdir(), `mockcloud-test-${process.pid}`);
export const TEST_DDB_ROOT = path.join(os.tmpdir(), `mockcloud-ddb-test-${process.pid}`);

process.env.MOCKCLOUD_S3_ROOT       = TEST_S3_ROOT;
process.env.MOCKCLOUD_DYNAMODB_ROOT = TEST_DDB_ROOT;
