// services/docker.js — Docker Desktop integration for EC2 instances
// Uses Docker Engine API via named pipe (Windows) or unix socket (Mac/Linux)
// Falls back gracefully if Docker is not available.
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Map AMI IDs → real Docker images
const AMI_TO_IMAGE = {
  'ami-ubuntu-22':  'ubuntu:22.04',
  'ami-debian-12':  'debian:12-slim',
  'ami-alpine-3':   'alpine:3.19',
  'ami-nixos-23':   'ubuntu:22.04',   // NixOS has no official slim image; use Ubuntu as stand-in
};

// Default image if AMI not found
const DEFAULT_IMAGE = 'ubuntu:22.04';

/**
 * Spin up a Docker container that represents an EC2 instance.
 * Returns the container ID (short) on success.
 * Throws on failure (Docker not available, image pull failed, etc.)
 */
export async function spawnDockerContainer(instance) {
  const image = AMI_TO_IMAGE[instance.ami] || DEFAULT_IMAGE;
  const containerName = `mc-ec2-${instance.id}`;

  // Labels for easy identification and restart reconciliation.
  // Values are double-quoted so spaces (e.g. in OS names) don't break the shell command.
  // The reconciler reads either `mc-*` (current) or legacy `lc-*` labels for
  // backward compatibility with containers created by older mockcloud builds.
  const labels = [
    `--label "mockcloud=ec2"`,
    `--label "mc-instance-id=${instance.id}"`,
    `--label "mc-name=${instance.name.replace(/[^a-zA-Z0-9_.-]/g,'-')}"`,
    `--label "mc-type=${instance.type}"`,
    `--label "mc-ami=${instance.ami}"`,
    `--label "mc-os=${(instance.os||'').replace(/"/g,'')}"`,
    `--label "mc-private-ip=${instance.privateIp}"`,
    `--label "mc-public-ip=${instance.publicIp||''}"`,
    `--label "mc-vcpu=${instance.vcpu}"`,
    `--label "mc-mem=${instance.mem}"`,
    `--label "mc-launched=${instance.launched}"`,
  ].join(' ');

  // Run container — detached, no port mapping by default
  // `tail -f /dev/null` keeps it alive without doing anything
  const cmd = `docker run -d --name ${containerName} ${labels} ${image} tail -f /dev/null`;

  try {
    const { stdout } = await execAsync(cmd, { timeout: 30000 });
    const fullId = stdout.trim();
    const shortId = fullId.slice(0, 12);
    console.log(`[EC2→Docker] Launched container ${containerName} (${shortId}) image=${image}`);
    return shortId;
  } catch (err) {
    // Common cases: Docker not running, image not found locally (would need pull)
    // Try pulling the image first if "Unable to find image" error
    if (err.message.includes('Unable to find image') || err.message.includes('pull')) {
      console.log(`[EC2→Docker] Pulling image ${image}…`);
      await execAsync(`docker pull ${image}`, { timeout: 120000 });
      const { stdout } = await execAsync(cmd, { timeout: 30000 });
      const shortId = stdout.trim().slice(0, 12);
      console.log(`[EC2→Docker] Launched after pull: ${containerName} (${shortId})`);
      return shortId;
    }
    throw err;
  }
}

/**
 * Perform an action on a running container.
 * action: 'stop' | 'start' | 'reboot' | 'terminate'
 */
export async function dockerAction(containerId, action) {
  if (!containerId) return;
  const cmds = {
    stop:      `docker stop ${containerId}`,
    start:     `docker start ${containerId}`,
    reboot:    `docker restart ${containerId}`,
    terminate: `docker rm -f ${containerId}`,
  };
  const cmd = cmds[action];
  if (!cmd) return;
  try {
    await execAsync(cmd, { timeout: 15000 });
    console.log(`[EC2→Docker] ${action} ${containerId} OK`);
  } catch (e) {
    console.warn(`[EC2→Docker] ${action} ${containerId} failed: ${e.message.split('\n')[0]}`);
  }
}

/**
 * List all Local Cloud EC2 containers currently running in Docker.
 */
export async function listDockerEC2Containers() {
  try {
    const { stdout } = await execAsync(
      `docker ps -a --filter "label=mockcloud=ec2" --format "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}"`,
      { timeout: 5000 }
    );
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [id, name, status, image] = line.split('\t');
      return { id, name, status, image };
    });
  } catch {
    return [];
  }
}

/**
 * On startup, re-populate the EC2 store from Docker containers that survived a restart.
 * Reads instance metadata from container labels written by spawnDockerContainer.
 */
export async function reconcileDockerInstances(store) {
  try {
    const { stdout: listOut } = await execAsync(
      `docker ps -a --filter "label=mockcloud=ec2" --format "{{.ID}}"`,
      { timeout: 5000 }
    );
    const containerIds = listOut.trim().split('\n').filter(Boolean);
    if (!containerIds.length) return;

    const { stdout: inspectOut } = await execAsync(
      `docker inspect ${containerIds.join(' ')}`,
      { timeout: 10000 }
    );
    const containers = JSON.parse(inspectOut);

    for (const container of containers) {
      const labels = container.Config?.Labels || {};
      // Prefer mc-* labels (current); fall back to lc-* for legacy containers.
      const lab = (key) => labels[`mc-${key}`] ?? labels[`lc-${key}`];
      const id = lab('instance-id');
      if (!id || store.ec2.instances[id]) continue;

      const dockerStatus = container.State?.Status || 'exited';
      const state = dockerStatus === 'running' ? 'running' : 'stopped';
      const shortId = container.Id.slice(0, 12);

      store.ec2.instances[id] = {
        id,
        name:            lab('name') || 'unnamed',
        state,
        type:            lab('type') || 't3.micro',
        ami:             lab('ami')  || 'ami-ubuntu-22',
        os:              lab('os')   || 'Ubuntu 22.04 LTS',
        privateIp:       lab('private-ip') || '10.0.1.1',
        publicIp:        lab('public-ip')  || null,
        vcpu:            parseFloat(lab('vcpu') || '1'),
        mem:             parseFloat(lab('mem')  || '1'),
        launched:        parseInt(lab('launched') || String(Date.now()), 10),
        containerId:     shortId,
        containerStatus: dockerStatus,
      };
      console.log(`[EC2→Docker] Reconciled ${id} (${lab('name')}) from container ${shortId} [${state}]`);
    }
  } catch (err) {
    console.log(`[EC2→Docker] Reconcile skipped: ${err.message.split('\n')[0]}`);
  }
}
