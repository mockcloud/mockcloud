// src/services/docker-health.js
// Single source of truth for "is the Docker daemon reachable right now?"
// Platform-agnostic: works on Mac/Windows (Docker Desktop) and Linux (dockerd).
// `docker info` returns non-zero if the daemon isn't reachable, regardless of
// how it's installed — so we don't need to guess sockets or pipes.

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Cache the last result for a short window so back-to-back callers
// (e.g. status poll + UI mode-change pre-check) don't both spawn `docker info`.
let cache = { ok: null, at: 0 };
const CACHE_TTL_MS = 3000;

function platformHint() {
    switch (process.platform) {
        case 'darwin':
            return 'Start Docker Desktop, wait for the whale icon to settle, then try again.';
        case 'win32':
            return 'Start Docker Desktop and wait for it to finish initializing, then try again.';
        case 'linux':
            return 'Start the Docker daemon (e.g. `sudo systemctl start docker`), then try again.';
        default:
            return 'Ensure the Docker daemon is running and reachable, then try again.';
    }
}

/**
 * Probe the Docker daemon. Returns { ok, platform, hint, reason? }.
 * `reason` is only set on failure — the first line of stderr, useful for logs.
 * Result is cached for 3s.
 */
export async function pingDocker({ force = false } = {}) {
    if (!force && cache.ok !== null && Date.now() - cache.at < CACHE_TTL_MS) {
        return { ...cache.value };
    }

    const result = { platform: process.platform, hint: platformHint() };
    try {
        // `docker info` hits the daemon's /info endpoint. 1.5s timeout is enough
        // for a healthy daemon (~50ms typical) but bounded if the daemon is hung.
        await execAsync('docker info --format "{{.ServerVersion}}"', { timeout: 1500 });
        result.ok = true;
    } catch (e) {
        result.ok = false;
        result.reason = (e.stderr || e.message || '').split('\n')[0].slice(0, 200);
    }

    cache = { ok: result.ok, at: Date.now(), value: result };
    return result;
}

/** Force the cache to expire — call after a known mode change. */
export function invalidateDockerCache() {
    cache = { ok: null, at: 0 };
}