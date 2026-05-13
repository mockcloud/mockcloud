import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { store } from '../store.js';

const sessions = new Map();
let nextId = 1;

// Detect best available shell on Windows: Git Bash > WSL > cmd.exe
// Git Bash preferred over WSL because it shares Windows' network stack —
// WSL has its own loopback, so 127.0.0.1 inside WSL doesn't reach the Windows host.
function detectWindowsShell() {
  const gitBashCandidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env.USERPROFILE ? `${process.env.USERPROFILE}\\AppData\\Local\\Programs\\Git\\bin\\bash.exe` : null,
  ].filter(Boolean);
  for (const p of gitBashCandidates) {
    if (existsSync(p)) return { type: 'gitbash', path: p };
  }

  const wslPath = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\wsl.exe`;
  if (existsSync(wslPath)) return { type: 'wsl', path: wslPath };

  return { type: 'cmd', path: process.env.ComSpec || 'cmd.exe' };
}

let _winShell = null;
function getWindowsShell() {
  return _winShell ??= detectWindowsShell();
}

const CLI_ENV = {
  AWS_DEFAULT_REGION:    'us-east-1',
  AWS_ENDPOINT_URL:      'http://localhost:4566',
  AWS_ACCESS_KEY_ID:     'local',
  AWS_SECRET_ACCESS_KEY: 'local',
};

export function createSession(type, instanceId) {
  if (type === 'ec2') {
    const inst = store.ec2.instances[instanceId];
    if (!inst) throw new Error(`Instance ${instanceId} not found`);
    if (!inst.containerId) throw new Error(
      'Instance has no Docker container — only Docker-backed instances support Connect.\n' +
      'Make sure Docker Desktop is running when you launch the instance.'
    );
  }

  const id = `sess-${nextId++}`;
  const session = {
    id, type,
    instanceId: instanceId || null,
    buffer: [], subs: new Set(),
    closed: false, busy: false,
    currentProc: null,
  };

  session.push = chunk => {
    session.buffer.push(chunk);
    if (session.buffer.length > 8000) session.buffer.shift();
    for (const fn of session.subs) fn(chunk);
  };

  // Welcome message — no process spawned yet
  if (type === 'cli') {
    let shellLabel;
    if (process.platform === 'win32') {
      const ws = getWindowsShell();
      shellLabel = ws.type === 'wsl' ? 'WSL (bash)' : ws.type === 'gitbash' ? 'Git Bash' : 'cmd.exe';
    } else {
      shellLabel = process.env.SHELL || '/bin/sh';
    }
    session.push({ t: 'o', d:
      '╔══════════════════════════════════════════════════════╗\r\n' +
      '║      MockCloud CLI  —  pre-configured shell        ║\r\n' +
      '╠══════════════════════════════════════════════════════╣\r\n' +
     `║  shell   ${shellLabel.slice(0,42).padEnd(44)}║\r\n` +
      '║  AWS_ENDPOINT_URL   = http://localhost:4566          ║\r\n' +
      '║  AWS_DEFAULT_REGION = us-east-1                     ║\r\n' +
      '╠══════════════════════════════════════════════════════╣\r\n' +
      '║  try:  aws s3 ls                                     ║\r\n' +
      '║        aws ec2 describe-instances                    ║\r\n' +
      '║        aws lambda list-functions                     ║\r\n' +
      '║        docker ps --filter label=mockcloud=ec2      ║\r\n' +
      '╚══════════════════════════════════════════════════════╝\r\n\r\n'
    });
  } else {
    const inst = store.ec2.instances[instanceId];
    session.push({ t: 'o', d:
      `Connected to ${inst.name || instanceId}\r\n` +
      `  OS:        ${inst.os}\r\n` +
      `  Type:      ${inst.type}\r\n` +
      `  Container: ${inst.containerId}\r\n\r\n`
    });
  }

  sessions.set(id, session);
  // Auto-expire after 30 min
  setTimeout(() => { if (sessions.has(id)) { closeSession(id); } }, 30 * 60 * 1000);
  return id;
}

export const getSession = id => sessions.get(id) ?? null;

export function subscribe(id, fn) {
  const s = sessions.get(id);
  if (!s) throw new Error('Session not found');
  s.subs.add(fn);
  return [...s.buffer];
}

export function unsubscribe(id, fn) {
  sessions.get(id)?.subs.delete(fn);
}

// Each command gets its own short-lived process — avoids TTY / buffering issues
export function execCommand(sessionId, command) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Session not found');
  if (s.busy) throw new Error('A command is already running — press Ctrl+C to cancel');

  let cmd, args, env;

  if (s.type === 'ec2') {
    const inst = store.ec2.instances[s.instanceId];
    if (!inst?.containerId) {
      s.push({ t: 'e', d: 'Error: container not available\r\n' });
      s.push({ t: 'r', code: 1 });
      return;
    }
    cmd  = 'docker';
    args = ['exec', inst.containerId, '/bin/sh', '-c', command];
    env  = process.env;
  } else {
    if (process.platform === 'win32') {
      const ws = getWindowsShell();
      if (ws.type === 'wsl') {
        // Pass env vars inline since WSL doesn't inherit Windows env automatically
        const envPrefix = Object.entries(CLI_ENV).map(([k,v]) => `export ${k}=${v}`).join('; ');
        cmd  = ws.path;
        args = ['--', 'bash', '-c', `${envPrefix}; ${command}`];
        env  = process.env;
      } else if (ws.type === 'gitbash') {
        cmd  = ws.path;
        args = ['-c', command];
        env  = { ...process.env, ...CLI_ENV };
      } else {
        cmd  = ws.path;
        args = ['/d', '/c', command];
        env  = { ...process.env, ...CLI_ENV };
      }
    } else {
      cmd  = '/bin/sh';
      args = ['-c', command];
      env  = { ...process.env, ...CLI_ENV };
    }
  }

  s.busy = true;
  const proc = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  s.currentProc = proc;

  proc.stdout.on('data', d => s.push({ t: 'o', d: d.toString() }));
  proc.stderr.on('data', d => s.push({ t: 'e', d: d.toString() }));

  proc.on('close', code => {
    s.busy = false;
    s.currentProc = null;
    s.push({ t: 'r', code: code ?? 0 });
  });

  proc.on('error', err => {
    s.busy = false;
    s.currentProc = null;
    s.push({ t: 'e', d: `\r\nCould not run command: ${err.message}\r\n` });
    s.push({ t: 'r', code: 1 });
  });

  proc.stdin.end(); // no stdin for one-shot commands
}

export function interrupt(sessionId) {
  const s = sessions.get(sessionId);
  if (s?.currentProc) {
    try { s.currentProc.kill('SIGTERM'); } catch {}
    try { s.currentProc.kill('SIGKILL'); } catch {}
  }
}

export function closeSession(id) {
  const s = sessions.get(id);
  if (s) {
    if (s.currentProc) { try { s.currentProc.kill(); } catch {} }
    s.push({ t: 'x', d: '0' });
    sessions.delete(id);
  }
}
