#!/usr/bin/env node
// scripts/conformance.mjs — run the vitest suite as a conformance harness
// against an EXTERNAL server implementation (spawn mode: one server process
// per test file, driven purely over HTTP).
//
//   node scripts/conformance.mjs                 # run the ratchet manifest vs the Go binary
//   node scripts/conformance.mjs --ci            # ratchet enforcement: exit 1 if a manifest file fails
//   node scripts/conformance.mjs --all           # progress report over every test file (never fails)
//   node scripts/conformance.mjs --all --strict  # full suite, failures are fatal
//   node scripts/conformance.mjs --files sqs.test.js s3.test.js
//   node scripts/conformance.mjs --server "node src/index.js"   # test another implementation
//
// The ratchet manifest (conformance/passing.json) lists test files that MUST
// pass against the Go server. Porting PRs append their files; once green,
// always green.
import { spawnSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const MANIFEST = path.join(ROOT, 'conformance', 'passing.json');

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = { ci: false, all: false, strict: false, server: null, files: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--ci') flags.ci = true;
  else if (a === '--all') flags.all = true;
  else if (a === '--strict') flags.strict = true;
  else if (a === '--server') flags.server = argv[++i];
  else if (a === '--files') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) flags.files.push(argv[++i]); }
  else { console.error(`unknown argument: ${a}`); process.exit(2); }
}

// ── file selection ──────────────────────────────────────────────────────────
function manifestFiles() {
  if (!existsSync(MANIFEST)) return [];
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}
function allFiles() {
  return readdirSync(TESTS_DIR).filter(f => f.endsWith('.test.js')).sort();
}

let files;
if (flags.files.length) files = flags.files.map(f => path.basename(f));
else if (flags.all) files = allFiles();
else files = manifestFiles();

if (files.length === 0) {
  console.log('conformance: manifest is empty — nothing to enforce yet.');
  process.exit(0);
}
const missing = files.filter(f => !existsSync(path.join(TESTS_DIR, f)));
if (missing.length) {
  console.error(`conformance: unknown test file(s): ${missing.join(', ')}`);
  process.exit(2);
}

// ── server command ──────────────────────────────────────────────────────────
function resolveServerCmd() {
  if (flags.server) return flags.server;
  // Default target: build the Go server and point the harness at the binary.
  const exe = process.platform === 'win32' ? 'mockcloud.exe' : 'mockcloud';
  const out = path.join(ROOT, 'bin', exe);
  console.log('conformance: building Go server…');
  const r = spawnSync('go', ['build', '-o', out, './cmd/mockcloud'], { cwd: ROOT, stdio: 'inherit', shell: false });
  if (r.error || r.status !== 0) {
    console.error('conformance: go build failed. Pass --server "<cmd>" to test another implementation.');
    process.exit(2);
  }
  return `"${out}"`; // quoted — helpers/server.js splitCommand honours quotes
}
const serverCmd = resolveServerCmd();

// ── run vitest ──────────────────────────────────────────────────────────────
const scratch = path.join(os.tmpdir(), `mockcloud-conformance-${process.pid}`);
mkdirSync(scratch, { recursive: true });
const jsonOut = path.join(scratch, 'results.json');

const vitestBin = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
console.log(`conformance: ${files.length} file(s) vs: ${serverCmd}\n`);
const run = spawnSync(process.execPath, [
  vitestBin, 'run', ...files.map(f => path.join('tests', f)),
  '--reporter=default', '--reporter=json', '--outputFile', jsonOut,
], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, MOCKCLOUD_SERVER_CMD: serverCmd, MOCKCLOUD_TEST_ENDPOINTS: '1' },
});

// ── report ──────────────────────────────────────────────────────────────────
let results;
try {
  results = JSON.parse(readFileSync(jsonOut, 'utf8'));
} catch {
  console.error('conformance: vitest produced no JSON output (crashed?)');
  process.exit(run.status ?? 1);
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}

const byFile = new Map();
for (const tr of results.testResults ?? []) {
  const name = path.basename(tr.name);
  const passed = tr.assertionResults.filter(a => a.status === 'passed').length;
  const failed = tr.assertionResults.filter(a => a.status === 'failed').length;
  byFile.set(name, { passed, failed, ok: tr.status === 'passed' });
}

const pad = Math.max(...files.map(f => f.length)) + 2;
console.log('\nconformance results:');
let anyFail = false;
for (const f of files) {
  const r = byFile.get(f);
  const ok = r?.ok ?? false;
  if (!ok) anyFail = true;
  console.log(`  ${f.padEnd(pad)} ${ok ? 'PASS' : 'FAIL'}  ${r ? `${r.passed} passed${r.failed ? `, ${r.failed} failed` : ''}` : '(no result)'}`);
}
console.log('');

if (flags.ci) {
  // Ratchet: every manifest file must pass, whatever file set was run.
  const ratchet = new Set(manifestFiles());
  const broken = files.filter(f => ratchet.has(f) && !(byFile.get(f)?.ok));
  if (broken.length) {
    console.error(`conformance: RATCHET BROKEN — previously-green file(s) failing: ${broken.join(', ')}`);
    process.exit(1);
  }
  console.log('conformance: ratchet holds.');
  process.exit(0);
}
if (flags.all && !flags.strict) process.exit(0); // progress-report mode
process.exit(anyFail ? 1 : 0);
