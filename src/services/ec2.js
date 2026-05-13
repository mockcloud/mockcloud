// services/ec2.js
import { store, randomId, arn } from '../store.js';
import { xmlResponse, errorXml, escapeXml, getRawBody } from '../middleware/response.js';

const INSTANCE_TYPES = {
  't3.nano':  { vcpu:1, mem:0.5 },
  't3.micro': { vcpu:2, mem:1 },
  't3.small': { vcpu:2, mem:2 },
  't3.medium':{ vcpu:2, mem:4 },
  'm6i.large':{ vcpu:2, mem:8 },
  'c6i.xlarge':{ vcpu:4, mem:8 },
};

const AMI_MAP = {
  'ami-ubuntu-22': 'Ubuntu 22.04 LTS',
  'ami-debian-12': 'Debian 12 (Bookworm)',
  'ami-alpine-3':  'Alpine Linux 3.19',
  'ami-nixos-23':  'NixOS 23.11',
};

export async function handler(req, res) {
  const body = getRawBody(req);
  const params = new URLSearchParams(body);
  const action = new URL(req.url,'http://x').searchParams.get('Action') || params.get('Action');

  switch (action) {
    case 'DescribeInstances': {
      const instances = Object.values(store.ec2.instances);
      const reservations = instances.map(i => `<item>
        <reservationId>r-${randomId(8)}</reservationId>
        <instancesSet><item>
          <instanceId>${i.id}</instanceId>
          <instanceType>${i.type}</instanceType>
          <imageId>${i.ami}</imageId>
          <instanceState><code>${stateCode(i.state)}</code><name>${i.state}</name></instanceState>
          <privateIpAddress>${i.privateIp}</privateIpAddress>
          ${i.publicIp ? `<ipAddress>${i.publicIp}</ipAddress>` : ''}
          <launchTime>${new Date(i.launched).toISOString()}</launchTime>
          <tagSet><item><key>Name</key><value>${escapeXml(i.name)}</value></item></tagSet>
        </item></instancesSet>
      </item>`).join('');
      return xmlResponse(res, 200, ec2Wrap('DescribeInstancesResponse',
        `<reservationSet>${reservations}</reservationSet>`));
    }

    case 'RunInstances': {
      const type = params.get('InstanceType') || 't3.micro';
      const imageId = params.get('ImageId') || 'ami-ubuntu-22';
      const count = parseInt(params.get('MaxCount') || '1');
      const nameTag = params.get('TagSpecification.1.Tag.1.Value') || params.get('TagSpecification.1.Tag.2.Value') || 'unnamed';
      const pubIp = params.get('AssociatePublicIpAddress') !== 'false';
      const specs = INSTANCE_TYPES[type] || { vcpu: 1, mem: 1 };
      const created = [];

      for (let idx = 0; idx < count; idx++) {
        const id = `i-${randomId(8)}`;
        const ip = `10.0.${Math.floor(Math.random()*254)+1}.${Math.floor(Math.random()*254)+1}`;
        const instance = {
          id, name: count > 1 ? `${nameTag}-${idx+1}` : nameTag,
          state: 'pending',
          type, ami: imageId, os: AMI_MAP[imageId] || imageId,
          privateIp: ip,
          publicIp: pubIp ? `203.0.${Math.floor(Math.random()*200)+10}.${Math.floor(Math.random()*254)+1}` : null,
          vcpu: specs.vcpu, mem: specs.mem,
          launched: Date.now(),
          containerId: null, containerStatus: 'n/a',
        };
        store.ec2.instances[id] = instance;
        created.push(instance);
      }

      // Try to spin up Docker containers for each instance
      try {
        const { spawnDockerContainer } = await import('./docker.js');
        for (const inst of created) {
          const containerId = await spawnDockerContainer(inst);
          inst.containerId    = containerId;
          inst.containerStatus = 'running';
          inst.state           = 'running';
        }
      } catch (e) {
        console.log(`[EC2] Docker unavailable (${e.message.split('\n')[0]}), using simulated instances`);
        created.forEach(inst => {
          setTimeout(() => { if (store.ec2.instances[inst.id]) store.ec2.instances[inst.id].state = 'running'; }, 2000);
        });
      }

      const items = created.map(i => `<item>
        <instanceId>${i.id}</instanceId>
        <instanceType>${i.type}</instanceType>
        <imageId>${i.ami}</imageId>
        <instanceState><code>0</code><name>pending</name></instanceState>
        <privateIpAddress>${i.privateIp}</privateIpAddress>
      </item>`).join('');
      return xmlResponse(res, 200, ec2Wrap('RunInstancesResponse', `<instancesSet>${items}</instancesSet>`));
    }

    case 'TerminateInstances': {
      const ids = getList(params, 'InstanceId');
      const results = ids.map(id => {
        const inst = store.ec2.instances[id];
        const prev = inst?.state || 'terminated';
        if (inst) {
          inst.state = 'terminated';
          dockerActionFor(inst, 'terminate');
          setTimeout(() => delete store.ec2.instances[id], 5000);
        }
        return `<item><instanceId>${id}</instanceId><previousState><name>${prev}</name></previousState><currentState><name>shutting-down</name></currentState></item>`;
      });
      return xmlResponse(res, 200, ec2Wrap('TerminateInstancesResponse', `<instancesSet>${results.join('')}</instancesSet>`));
    }

    case 'StopInstances': {
      const ids = getList(params, 'InstanceId');
      ids.forEach(id => {
        const inst = store.ec2.instances[id];
        if (inst) {
          inst.state = 'stopped';
          dockerActionFor(inst, 'stop');
        }
      });
      return xmlResponse(res, 200, ec2Wrap('StopInstancesResponse',
        `<instancesSet>${ids.map(id=>`<item><instanceId>${id}</instanceId><currentState><name>stopped</name></currentState></item>`).join('')}</instancesSet>`));
    }

    case 'StartInstances': {
      const ids = getList(params, 'InstanceId');
      ids.forEach(id => {
        const inst = store.ec2.instances[id];
        if (inst) {
          inst.state = 'pending';
          dockerActionFor(inst, 'start');
          setTimeout(() => { if (inst) inst.state = 'running'; }, 2000);
        }
      });
      return xmlResponse(res, 200, ec2Wrap('StartInstancesResponse',
        `<instancesSet>${ids.map(id=>`<item><instanceId>${id}</instanceId><currentState><name>pending</name></currentState></item>`).join('')}</instancesSet>`));
    }

    case 'DescribeImages':
      return xmlResponse(res, 200, ec2Wrap('DescribeImagesResponse',
        `<imagesSet>${Object.entries(AMI_MAP).map(([id,name])=>`<item><imageId>${id}</imageId><name>${escapeXml(name)}</name><state>available</state></item>`).join('')}</imagesSet>`));

    case 'DescribeAvailabilityZones':
      return xmlResponse(res, 200, ec2Wrap('DescribeAvailabilityZonesResponse',
        `<availabilityZoneInfo><item><zoneName>us-east-1a</zoneName><state>available</state><regionName>us-east-1</regionName></item><item><zoneName>us-east-1b</zoneName><state>available</state><regionName>us-east-1</regionName></item></availabilityZoneInfo>`));

    case 'DescribeRegions':
      return xmlResponse(res, 200, ec2Wrap('DescribeRegionsResponse',
        `<regionInfo><item><regionName>us-east-1</regionName><regionEndpoint>localhost:4566</regionEndpoint></item></regionInfo>`));

    case 'CreateSecurityGroup': {
      const sgId = `sg-${randomId(8)}`;
      store.ec2.securityGroups[sgId] = { id: sgId, name: params.get('GroupName'), description: params.get('GroupDescription'), rules: [] };
      return xmlResponse(res, 200, ec2Wrap('CreateSecurityGroupResponse', `<groupId>${sgId}</groupId>`));
    }

    case 'DescribeSecurityGroups': {
      const sgs = Object.values(store.ec2.securityGroups).map(sg => `<item><groupId>${sg.id}</groupId><groupName>${escapeXml(sg.name)}</groupName><groupDescription>${escapeXml(sg.description||'')}</groupDescription></item>`).join('');
      return xmlResponse(res, 200, ec2Wrap('DescribeSecurityGroupsResponse', `<securityGroupInfo>${sgs}</securityGroupInfo>`));
    }

    case 'CreateKeyPair': {
      const name = params.get('KeyName');
      const keyId = `key-${randomId(8)}`;
      store.ec2.keyPairs[name] = { name, keyId, fingerprint: randomId(20), material: `-----BEGIN RSA PRIVATE KEY-----\n${randomId(256)}\n-----END RSA PRIVATE KEY-----` };
      return xmlResponse(res, 200, ec2Wrap('CreateKeyPairResponse', `<keyName>${escapeXml(name)}</keyName><keyFingerprint>${randomId(20)}</keyFingerprint><keyMaterial>${store.ec2.keyPairs[name].material}</keyMaterial>`));
    }

    case 'DescribeKeyPairs': {
      const kps = Object.values(store.ec2.keyPairs).map(k=>`<item><keyName>${escapeXml(k.name)}</keyName><keyFingerprint>${k.fingerprint}</keyFingerprint></item>`).join('');
      return xmlResponse(res, 200, ec2Wrap('DescribeKeyPairsResponse', `<keySet>${kps}</keySet>`));
    }

    default:
      return xmlResponse(res, 200, ec2Wrap('UnknownResponse', '<ok/>'));
  }
}

function ec2Wrap(tag, inner) {
  return `<?xml version="1.0"?><${tag} xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">${inner}<requestId>${randomId(36)}</requestId></${tag}>`;
}

function stateCode(s) {
  return { running:16, stopped:80, pending:0, terminated:48, stopping:64 }[s] || 0;
}

function getList(params, prefix) {
  const result = [];
  for (let i = 1; ; i++) {
    const v = params.get(`${prefix}.${i}`);
    if (!v) break;
    result.push(v);
  }
  return result;
}

// Fire-and-forget Docker action for an instance that has a container.
// Lazy-imports docker.js so this stays a no-op when Docker isn't available.
function dockerActionFor(instance, action) {
  if (!instance?.containerId) return;
  import('./docker.js')
    .then(({ dockerAction }) => dockerAction(instance.containerId, action))
    .catch(()=>{});
}
