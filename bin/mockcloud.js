#!/usr/bin/env node
// bin/mockcloud.js — `npx mockcloud` entry point.
//
// Resolves the platform-native MockCloud binary and execs it, passing through
// argv, stdio, and exit code. Resolution order:
//   1. MOCKCLOUD_BIN            — explicit override (dev / CI)
//   2. @mockcloud/cli-<os>-<arch> — the prebuilt platform package (esbuild
//      pattern; published as optionalDependencies by the release pipeline)
//   3. ./bin/mockcloud[.exe]    — a locally-built binary (npm run build)
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.platform === 'win32' ? 'mockcloud.exe' : 'mockcloud';

function resolveBinary() {
  if (process.env.MOCKCLOUD_BIN) return process.env.MOCKCLOUD_BIN;

  const pkg = `@mockcloud/cli-${process.platform}-${process.arch}`;
  try {
    // The platform package ships the binary as its single file.
    return require.resolve(`${pkg}/bin/${exe}`);
  } catch { /* not installed — fall through */ }

  const local = path.join(here, exe);
  if (existsSync(local)) return local;

  return null;
}

const binary = resolveBinary();
if (!binary) {
  process.stderr.write(
    `mockcloud: no native binary found for ${process.platform}-${process.arch}.\n` +
    `Install the platform package, set MOCKCLOUD_BIN, or build locally with \`npm run build\`.\n`);
  process.exit(1);
}

const res = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (res.error) {
  process.stderr.write(`mockcloud: failed to launch ${binary}: ${res.error.message}\n`);
  process.exit(1);
}
process.exit(res.status ?? 0);
