// routes/ec2.js — /mockcloud/ec2/* UI API
import { store, randomId } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

const body = req => req.parsedBody || {};

// Match the API-boundary regex in src/services/ec2.js. Both UI and AWS
// surfaces funnel into spawnDockerContainer; both must validate.
const SAFE_EC2_ID = /^[A-Za-z0-9._-]{1,64}$/;

const TYPE_SPECS = {
  't3.nano': { vcpu: 1, mem: 0.5 },
  't3.micro': { vcpu: 2, mem: 1 },
  't3.small': { vcpu: 2, mem: 2 },
  't3.medium': { vcpu: 2, mem: 4 },
  'm6i.large': { vcpu: 2, mem: 8 },
  'c6i.xlarge': { vcpu: 4, mem: 8 },
};

const AMI_OS = {
  'ami-ubuntu-22': 'Ubuntu 22.04 LTS',
  'ami-debian-12': 'Debian 12',
  'ami-alpine-3': 'Alpine Linux 3.19',
  'ami-nixos-23': 'NixOS 23.11',
};

export function registerEC2Routes(app) {

  app.get('/mockcloud/ec2/instances', (req, res) => {
    jsonResponse(res, 200, { instances: Object.values(store.ec2.instances) });
  });

  app.post('/mockcloud/ec2/instances', async (req, res) => {
    const { name, type, ami, assignPublicIp } = body(req);
    if (type != null && !SAFE_EC2_ID.test(type)) {
      return errorJson(res, 400, 'ValidationError', 'type must match [A-Za-z0-9._-]{1,64}');
    }
    if (ami != null && !SAFE_EC2_ID.test(ami)) {
      return errorJson(res, 400, 'ValidationError', 'ami must match [A-Za-z0-9._-]{1,64}');
    }
    const id = `i-${randomId(8)}`;
    const specs = TYPE_SPECS[type] || { vcpu: 1, mem: 1 };
    const instance = {
      id,
      name: name || 'unnamed',
      state: 'pending',
      type: type || 't3.micro',
      ami: ami || 'ami-ubuntu-22',
      os: AMI_OS[ami] || ami || 'Ubuntu 22.04 LTS',
      privateIp: `10.0.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
      publicIp: assignPublicIp
        ? `203.0.${Math.floor(Math.random() * 200) + 10}.${Math.floor(Math.random() * 254) + 1}`
        : null,
      vcpu: specs.vcpu,
      mem: specs.mem,
      launched: Date.now(),
      containerId: null,
      containerStatus: 'n/a',
    };
    store.ec2.instances[id] = instance;

    // Lite mode — simulated only, no Docker
    if (store.ec2.mode === 'lite') {
      setTimeout(() => { if (store.ec2.instances[id]) store.ec2.instances[id].state = 'running'; }, 500);
    } else {
      // VMM mode — try Docker. If it fails, this instance falls back to
      // simulated AND we flip the global mode to lite so subsequent launches
      // don't keep hitting the dead daemon. The next status poll surfaces
      // dockerAvailable=false to the UI which then re-renders the toggle.
      try {
        const { spawnDockerContainer } = await import('../services/docker.js');
        const containerId = await spawnDockerContainer(instance);
        instance.containerId = containerId;
        instance.containerStatus = 'running';
        instance.state = 'running';
      } catch (e) {
        const reason = e.message.split('\n')[0];
        console.log(`[EC2] Docker unavailable (${reason}); falling back to simulated mode`);
        store.ec2.mode = 'lite';
        instance.fallbackReason = reason;
        setTimeout(() => { if (store.ec2.instances[id]) store.ec2.instances[id].state = 'running'; }, 2000);
        // Bust the docker-health cache so the next /status poll reports the
        // new reality immediately rather than serving the stale "ok" value.
        try {
          const { invalidateDockerCache } = await import('../services/docker-health.js');
          invalidateDockerCache();
        } catch { }
      }
    }

    store.addTrail({ method: 'POST', path: '/ec2/instances', status: 201, latency: 8 });
    jsonResponse(res, 201, instance);
  });

  app.post('/mockcloud/ec2/instances/:id/action', async (req, res) => {
    const { action } = body(req);
    const inst = store.ec2.instances[req.params.id];
    if (!inst) return errorJson(res, 404, 'NotFound', 'Instance not found');

    if (inst.containerId) {
      try {
        const { dockerAction } = await import('../services/docker.js');
        await dockerAction(inst.containerId, action);
      } catch (e) {
        console.log(`[EC2] Docker action failed: ${e.message.split('\n')[0]}`);
      }
    }

    if (action === 'stop') inst.state = 'stopped';
    else if (action === 'start') { inst.state = 'pending'; setTimeout(() => { if (inst) inst.state = 'running'; }, 2000); }
    else if (action === 'reboot') { inst.state = 'pending'; setTimeout(() => { if (inst) inst.state = 'running'; }, 1000); }
    else if (action === 'terminate') {
      inst.state = 'terminated';
      if (inst.containerId) {
        try { const { dockerAction } = await import('../services/docker.js'); await dockerAction(inst.containerId, 'terminate'); } catch { }
      }
      setTimeout(() => delete store.ec2.instances[req.params.id], 5000);
    }

    store.addTrail({ method: 'POST', path: `/ec2/${req.params.id}/${action}`, status: 200, latency: 3 });
    jsonResponse(res, 200, { id: req.params.id, action, state: inst.state });
  });

  app.delete('/mockcloud/ec2/instances/:id', async (req, res) => {
    const inst = store.ec2.instances[req.params.id];
    if (!inst) return errorJson(res, 404, 'NotFound', 'Instance not found');
    if (inst.containerId) {
      try { const { dockerAction } = await import('../services/docker.js'); await dockerAction(inst.containerId, 'terminate'); } catch { }
    }
    delete store.ec2.instances[req.params.id];
    store.addTrail({ method: 'DELETE', path: `/ec2/${req.params.id}`, status: 200, latency: 1 });
    jsonResponse(res, 200, { terminated: req.params.id });
  });
}
