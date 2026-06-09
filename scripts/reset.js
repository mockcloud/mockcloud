#!/usr/bin/env node
// scripts/reset.js — flush all MockCloud resources via the running daemon.
// Usage:
//   npm run reset                          # reset everything
//   npm run reset -- --service ec2         # reset just one service
//   npm run reset -- --host 127.0.0.1:4566 # custom host:port
//   npm run reset -- --yes                 # skip confirmation prompt

import { argv, stdout, stdin, exit } from 'node:process';
import { createInterface } from 'node:readline';

const args = argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return (!v || v.startsWith('--')) ? true : v;
}

const host    = flag('host', '127.0.0.1:4566');
const service = flag('service', null);
const yes     = flag('yes', false) || flag('y', false);

const target = service ? `service "${service}"` : 'ALL resources';
const url    = `http://${host}/mockcloud/reset${service ? `?service=${encodeURIComponent(service)}` : ''}`;

async function confirm(prompt) {
  if (yes) return true;
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise(r => rl.question(prompt, a => { rl.close(); r(/^y(es)?$/i.test(a.trim())); }));
}

(async () => {
  const ok = await confirm(`This will permanently delete ${target} on ${host}.\nContinue? [y/N] `);
  if (!ok) { console.log('Aborted.'); exit(1); }

  let r;
  try {
    r = await fetch(url, { method: 'DELETE' });
  } catch (e) {
    console.error(`Failed to reach MockCloud at ${host}: ${e.message}`);
    console.error('Is the daemon running? Start it with: npm start');
    exit(1);
  }

  if (!r.ok) {
    console.error(`Reset failed: HTTP ${r.status}`);
    console.error(await r.text().catch(() => ''));
    exit(1);
  }

  const data = await r.json().catch(() => ({}));
  console.log(`✓ Reset complete (${data.reset || 'all'})`);
})();
