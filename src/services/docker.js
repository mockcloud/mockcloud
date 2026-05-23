// services/docker.js — Docker Desktop integration for EC2 instances
// Uses Docker Engine API via named pipe (Windows) or unix socket (Mac/Linux)
// Falls back gracefully if Docker is not available.
//
// We invoke the docker CLI with execFile (argv array) rather than exec (shell
// command string) so attacker-controlled instance metadata (type, ami, os…)
// becomes a literal argument and can't break out of quoting. The API-boundary
// validators in src/services/ec2.js and src/routes/ec2.js are a defense layer
// on top of this — both must be defeated to land an injection.
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Map AMI IDs → real Docker images
const AMI_TO_IMAGE = {
  'ami-ubuntu-22':  'ubuntu:22.04',
  'ami-debian-12':  'debian:12-slim',
  'ami-alpine-3':   'alpine:3.19',
  'ami-nixos-23':   'ubuntu:22.04',   // NixOS has no official slim image; use Ubuntu as stand-in
};

// Default image if AMI not found
const DEFAULT_IMAGE = 'ubuntu:22.04';

// Sanitize a label value: docker labels are key=value, value can contain
// almost anything but we strip control chars + '"' just to keep `docker ps`
// output readable. Crucially, none of this matters for security — execFile
// hands the string to the kernel as a single argv element, no shell parsing.
function labelValue(v) {
  return String(v ?? '').replace(/[\x00-\x1f"]/g, '');
}

/**
 * Spin up a Docker container that represents an EC2 instance.
 * Returns the container ID (short) on success.
 * Throws on failure (Docker not available, image pull failed, etc.)
 */
export async function spawnDockerContainer(instance) {
  const image = AMI_TO_IMAGE[instance.ami] || DEFAULT_IMAGE;
  const containerName = `mc-ec2-${instance.id}`;

  // Each --label is two argv tokens. The reconciler reads either `mc-*`
  // (current) or legacy `lc-*` labels for backward compatibility with
  // containers created by older mockcloud builds.
  const labels = [
    ['mockcloud', 'ec2'],
    ['mc-instance-id', instance.id],
    ['mc-name', instance.name.replace(/[^a-zA-Z0-9_.-]/g, '-')],
    ['mc-type', instance.type],
    ['mc-ami', instance.ami],
    ['mc-os', instance.os || ''],
    ['mc-private-ip', instance.privateIp],
    ['mc-public-ip', instance.publicIp || ''],
    ['mc-vcpu', instance.vcpu],
    ['mc-mem', instance.mem],
    ['mc-launched', instance.launched],
  ].flatMap(([k, v]) => ['--label', `${k}=${labelValue(v)}`]);

  // detached, no port mapping; `tail -f /dev/null` keeps it alive doing nothing
  const args = ['run', '-d', '--name', containerName, ...labels, image, 'tail', '-f', '/dev/null'];

  try {
    const { stdout } = await execFileAsync('docker', args, { timeout: 30000 });
    const fullId = stdout.trim();
    const shortId = fullId.slice(0, 12);
    console.log(`[EC2→Docker] Launched container ${containerName} (${shortId}) image=${image}`);
    return shortId;
  } catch (err) {
    if (err.message.includes('Unable to find image') || err.message.includes('pull')) {
      console.log(`[EC2→Docker] Pulling image ${image}…`);
      await execFileAsync('docker', ['pull', image], { timeout: 120000 });
      const { stdout } = await execFileAsync('docker', args, { timeout: 30000 });
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
  const argsByAction = {
    stop:      ['stop', containerId],
    start:     ['start', containerId],
    reboot:    ['restart', containerId],
    terminate: ['rm', '-f', containerId],
  };
  const args = argsByAction[action];
  if (!args) return;
  try {
    await execFileAsync('docker', args, { timeout: 15000 });
    console.log(`[EC2→Docker] ${action} ${containerId} OK`);
  } catch (e) {
    console.warn(`[EC2→Docker] ${action} ${containerId} failed: ${e.message.split('\n')[0]}`);
  }
}

/**
 * List all MockCloud EC2 containers currently running in Docker.
 */
export async function listDockerEC2Containers() {
  try {
    const { stdout } = await execFileAsync('docker',
      ['ps', '-a', '--filter', 'label=mockcloud=ec2', '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}'],
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
    const { stdout: listOut } = await execFileAsync('docker',
      ['ps', '-a', '--filter', 'label=mockcloud=ec2', '--format', '{{.ID}}'],
      { timeout: 5000 }
    );
    const containerIds = listOut.trim().split('\n').filter(Boolean);
    if (!containerIds.length) return;

    const { stdout: inspectOut } = await execFileAsync('docker',
      ['inspect', ...containerIds],
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
