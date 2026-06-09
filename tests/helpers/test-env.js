// tests/helpers/test-env.js
// MUST be imported BEFORE any src/ module that captures a storage-root env var
// at load time (s3.js → S3_ROOT, dynamodb/persistence.js → DDB_ROOT). ESM
// evaluates imports depth-first in source order, so importing this module first
// in server.js guarantees these are set before those consts are read.
import os from 'os';
import path from 'path';

// Disk roots are unique per worker. Under vitest's `forks` pool each test file
// runs in its own process (distinct pid); VITEST_POOL_ID adds extra safety if a
// worker process is ever reused. Outside vitest it falls back to just the pid.
const WORKER = `${process.pid}-${process.env.VITEST_POOL_ID ?? '0'}`;
export const TEST_S3_ROOT  = path.join(os.tmpdir(), `mockcloud-test-${WORKER}`);
export const TEST_DDB_ROOT = path.join(os.tmpdir(), `mockcloud-ddb-test-${WORKER}`);

process.env.MOCKCLOUD_S3_ROOT       = TEST_S3_ROOT;
process.env.MOCKCLOUD_DYNAMODB_ROOT = TEST_DDB_ROOT;

// Fast background-poll cadence so eventing tests don't wait a full second.
process.env.MOCKCLOUD_POLL_INTERVAL_MS ??= '50';
