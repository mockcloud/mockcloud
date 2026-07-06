// services/dynamodb/persistence.js — disk persistence for DynamoDB tables.
//
// Storage model: the whole tables map (schema + items + indexes + metrics) is
// serialised to a single JSON snapshot at
//   ~/.mockcloud/dynamodb/tables.json
// so a developer's tables and data survive a server restart — the same promise
// the S3 emulator makes for object bytes (see src/services/s3.js).
//
// Writes are debounced and atomic (temp file + rename) so a burst of PutItems
// doesn't thrash the disk and a crash mid-write can't corrupt the snapshot.
import { store, randomId } from '../../store.js';
import path from 'path';
import os from 'os';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'fs';

const DDB_ROOT = process.env.MOCKCLOUD_DYNAMODB_ROOT || path.join(os.homedir(), '.mockcloud', 'dynamodb');
const SNAPSHOT = () => path.join(DDB_ROOT, 'tables.json');

let hydrated = false;

// Load the tables snapshot into store.dynamodb.tables. Idempotent — safe to
// call on every module load. Existing in-memory tables are not clobbered.
// Pass force=true to re-read after an in-memory reset (used by tests to prove
// data survives a "restart").
export function hydrateFromDisk(force = false) {
  if (hydrated && !force) return;
  hydrated = true;
  // PERSIST=off promises a purely in-memory run — that has to gate reads
  // too, or a snapshot from an earlier persisted session would still load.
  if (process.env.MOCKCLOUD_DYNAMODB_PERSIST === 'off') return;
  const file = SNAPSHOT();
  if (!existsSync(file)) return;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const tables = data && data.tables ? data.tables : {};
    for (const [name, t] of Object.entries(tables)) {
      if (!store.dynamodb.tables[name]) store.dynamodb.tables[name] = t;
    }
  } catch (e) {
    console.warn('[DynamoDB persistence] failed to hydrate:', e.message);
  }
}

let timer = null;
// Schedule a debounced snapshot write. Call after every table/item mutation.
export function persist() {
  if (process.env.MOCKCLOUD_DYNAMODB_PERSIST === 'off') return;
  if (timer) return;
  timer = setTimeout(() => { timer = null; writeSnapshot(); }, 200);
  timer.unref?.();
}

// Force an immediate synchronous write (used by tests / shutdown).
export function persistNow() {
  if (timer) { clearTimeout(timer); timer = null; }
  writeSnapshot();
}

function writeSnapshot() {
  try {
    mkdirSync(DDB_ROOT, { recursive: true });
    const target = SNAPSHOT();
    const tmp = target + '.tmp-' + randomId(8);
    const body = JSON.stringify({ version: 1, savedAt: Date.now(), tables: store.dynamodb.tables });
    writeFileSync(tmp, body);
    try { renameSync(tmp, target); }
    catch { writeFileSync(target, body); try { rmSync(tmp, { force: true }); } catch {} }
  } catch (e) {
    console.warn('[DynamoDB persistence] failed to persist:', e.message);
  }
}

// Remove the on-disk snapshot, cancel any pending debounced write (so a write
// queued just before a reset can't recreate the file), and reset the hydrate
// guard. Used by the DELETE /mockcloud/reset route and by the test helper
// resetStore() so reset tables can't resurrect from a stale snapshot.
export function wipeDisk() {
  if (timer) { clearTimeout(timer); timer = null; }
  hydrated = false;
  try { rmSync(SNAPSHOT(), { force: true }); } catch {}
}

// Flush any pending debounced write when the process is shutting down so a
// Ctrl+C right after a write doesn't lose data. Only meaningful for the real
// server; harmless under the test runner.
if (process.env.MOCKCLOUD_DYNAMODB_PERSIST !== 'off') {
  const flush = () => { if (timer) writeSnapshot(); };
  process.once('SIGINT', () => { flush(); process.exit(0); });
  process.once('SIGTERM', () => { flush(); process.exit(0); });
  process.once('beforeExit', flush);
}
