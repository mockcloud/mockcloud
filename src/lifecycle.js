// src/lifecycle.js — owns all background work (pollers, schedulers) so the daemon
// AND the test harness can start/stop it cleanly. Without a single stop point, an
// interval keeps the process (or a vitest `forks` worker) alive forever.
//
// Feature modules register a tick with `registerTick(fn)` (at import time);
// `startBackground()` runs every registered tick on an interval. Tests can call
// `runTicksOnce()` (or a feature's own exported `*Once()` fn) for deterministic,
// sleep-free assertions.

const ticks = [];
let timer = null;

// Fast in tests (test-env sets it), 1s in production.
const INTERVAL_MS = parseInt(process.env.MOCKCLOUD_POLL_INTERVAL_MS || '1000', 10) || 1000;

export function registerTick(fn) {
  if (typeof fn === 'function' && !ticks.includes(fn)) ticks.push(fn);
}

export function runTicksOnce() {
  for (const fn of ticks) {
    try { fn(); } catch (e) { console.warn('[lifecycle] tick failed:', e.message); }
  }
}

export function startBackground() {
  if (timer) return;                 // idempotent
  timer = setInterval(runTicksOnce, INTERVAL_MS);
  timer.unref?.();
}

export function stopBackground() {
  if (timer) { clearInterval(timer); timer = null; }
}
