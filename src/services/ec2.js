// services/ec2.js
import { store, randomId, arn } from '../store.js';
import { xmlResponse, errorXml, escapeXml, getRawBody } from '../middleware/response.js';

// Strict allowlist for values that flow into the Docker CLI as labels/args.
// Catches the injection vector even if a future code path drops the
// execFile-vs-exec hardening in services/docker.js.
const SAFE_EC2_ID = /^[A-Za-z0-9._-]{1,64}$/;

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
      // Support InstanceId.N direct params and Filter.N.Name=instance-id filters
      const directIds = getList(params, 'InstanceId');
      let filterIds = directIds.length ? directIds : [];
      if (!filterIds.length) {
        for (let f = 1; f <= 10; f++) {
          const name = params.get(`Filter.${f}.Name`);
          if (name === 'instance-id') {
            filterIds = getList(params, `Filter.${f}.Value`);
            break;
          }
        }
      }
      const allInstances = Object.values(store.ec2.instances);
      const filtered = filterIds.length ? allInstances.filter(i => filterIds.includes(i.id)) : allInstances;
      const reservations = filtered.map(i => {
        const tagItems = Object.entries(i.tags || { Name: i.name }).map(([k,v]) =>
          `<item><key>${escapeXml(k)}</key><value>${escapeXml(v)}</value></item>`
        ).join('');
        return `<item>
          <reservationId>r-${randomId(8)}</reservationId>
          <ownerId>123456789012</ownerId>
          <groupSet/>
          <instancesSet><item>
            <instanceId>${i.id}</instanceId>
            <instanceType>${i.type}</instanceType>
            <imageId>${i.ami}</imageId>
            <instanceState><code>${stateCode(i.state)}</code><name>${i.state}</name></instanceState>
            <privateDnsName>${i.id}.internal</privateDnsName>
            <privateIpAddress>${i.privateIp}</privateIpAddress>
            ${i.publicIp ? `<ipAddress>${i.publicIp}</ipAddress><dnsName>${i.id}.compute.amazonaws.com</dnsName>` : ''}
            <launchTime>${new Date(i.launched).toISOString()}</launchTime>
            <placement><availabilityZone>us-east-1a</availabilityZone><tenancy>default</tenancy></placement>
            <architecture>x86_64</architecture>
            <virtualizationType>hvm</virtualizationType>
            <hypervisor>nitro</hypervisor>
            <vpcId>vpc-mockcloud1</vpcId>
            <subnetId>subnet-mock0001</subnetId>
            <sourceDestCheck>true</sourceDestCheck>
            <groupSet/>
            <tagSet>${tagItems}</tagSet>
            <networkInterfaceSet><item>
              <networkInterfaceId>eni-${randomId(8)}</networkInterfaceId>
              <subnetId>subnet-mock0001</subnetId>
              <vpcId>vpc-mockcloud1</vpcId>
              <privateIpAddress>${i.privateIp}</privateIpAddress>
              ${i.publicIp ? `<association><publicIp>${i.publicIp}</publicIp></association>` : ''}
              <attachment><deviceIndex>0</deviceIndex><status>attached</status></attachment>
            </item></networkInterfaceSet>
          </item></instancesSet>
        </item>`;
      }).join('');
      return xmlResponse(res, 200, ec2Wrap('DescribeInstancesResponse',
        `<reservationSet>${reservations}</reservationSet>`));
    }

    case 'DescribeInstanceStatus': {
      // Terraform v5 waits for system+instance status checks to be "ok" before marking creation done
      const directIds = getList(params, 'InstanceId');
      let filterIds = directIds.length ? directIds : [];
      if (!filterIds.length) {
        for (let f = 1; f <= 10; f++) {
          const name = params.get(`Filter.${f}.Name`);
          if (name === 'instance-id') {
            filterIds = getList(params, `Filter.${f}.Value`);
            break;
          }
        }
      }
      const allInstances = Object.values(store.ec2.instances);
      const targets = (filterIds.length ? allInstances.filter(i => filterIds.includes(i.id)) : allInstances)
        .filter(i => i.state === 'running');
      const items = targets.map(i => `<item>
        <instanceId>${i.id}</instanceId>
        <availabilityZone>us-east-1a</availabilityZone>
        <instanceState><code>16</code><name>running</name></instanceState>
        <systemStatus>
          <status>ok</status>
          <details><item><name>reachability</name><status>passed</status></item></details>
        </systemStatus>
        <instanceStatus>
          <status>ok</status>
          <details><item><name>reachability</name><status>passed</status></item></details>
        </instanceStatus>
      </item>`).join('');
      return xmlResponse(res, 200, ec2Wrap('DescribeInstanceStatusResponse', `<instanceStatusSet>${items}</instanceStatusSet>`));
    }

    case 'DescribeInstanceAttribute': {
      const instId = params.get('InstanceId');
      const attr = params.get('Attribute') || '';
      const inst = store.ec2.instances[instId];
      if (!inst) return xmlResponse(res, 400, ec2Wrap('ErrorResponse',
        '<Errors><Error><Code>InvalidInstanceID.NotFound</Code><Message>Instance not found</Message></Error></Errors>'));
      const valueXml = {
        userData:             '<userData/>',
        disableApiTermination:'<disableApiTermination><value>false</value></disableApiTermination>',
        disableApiStop:       '<disableApiStop><value>false</value></disableApiStop>',
        instanceType:         `<instanceType><value>${inst.type}</value></instanceType>`,
        sourceDestCheck:      '<sourceDestCheck><value>true</value></sourceDestCheck>',
        rootDeviceName:       '<rootDeviceName><value>/dev/xvda</value></rootDeviceName>',
      }[attr] || `<${attr}/>`;
      return xmlResponse(res, 200, ec2Wrap('DescribeInstanceAttributeResponse',
        `<instanceId>${instId}</instanceId>${valueXml}`));
    }

    case 'RunInstances': {
      const type = params.get('InstanceType') || 't3.micro';
      const imageId = params.get('ImageId') || 'ami-ubuntu-22';
      if (!SAFE_EC2_ID.test(type) || !SAFE_EC2_ID.test(imageId)) {
        return xmlResponse(res, 400, ec2Wrap('ErrorResponse',
          '<Errors><Error><Code>InvalidParameterValue</Code><Message>InstanceType and ImageId must match [A-Za-z0-9._-]{1,64}</Message></Error></Errors>'));
      }
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
        };
        store.ec2.instances[id] = instance;
        created.push(instance);
      }

      created.forEach(inst => {
        const t = setTimeout(() => { if (store.ec2.instances[inst.id]) store.ec2.instances[inst.id].state = 'running'; }, 2000);
        t.unref?.();
      });

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
          inst.state = 'shutting-down';
          // Transition to terminated after 1s so Terraform's DescribeInstances
          // waiter sees the correct terminal state instead of NotFound.
          // Previously the instance was deleted after 5s, which caused the provider
          // to get InvalidInstanceID.NotFound and time out for 3 minutes.
          const t1 = setTimeout(() => {
            if (store.ec2.instances[id]) store.ec2.instances[id].state = 'terminated';
          }, 1000);
          t1.unref?.();
          // Clean up from store after 5 minutes — long past any TF waiter poll cycle.
          const t2 = setTimeout(() => delete store.ec2.instances[id], 300_000);
          t2.unref?.();
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
          const t = setTimeout(() => { if (inst) inst.state = 'running'; }, 2000);
          t.unref?.();
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
      store.ec2.securityGroups[sgId] = {
        id: sgId,
        name: params.get('GroupName'),
        description: params.get('GroupDescription'),
        vpcId: params.get('VpcId') || 'vpc-mockcloud1',
        tags: {},
        ingressRules: [],
        egressRules: [],
      };
      return xmlResponse(res, 200, ec2Wrap('CreateSecurityGroupResponse', `<groupId>${sgId}</groupId>`));
    }

    case 'DescribeSecurityGroups': {
      // Support direct GroupId.N params and both filter-by-group-id and filter-by-vpc-id
      const directIds = getList(params, 'GroupId');
      let filterIds = directIds.length ? directIds : [];
      if (!filterIds.length) {
        for (let f = 1; f <= 5; f++) {
          const name = params.get(`Filter.${f}.Name`);
          if (name === 'group-id' || name === 'GroupId') {
            filterIds = getList(params, `Filter.${f}.Value`);
            break;
          }
        }
      }
      const allSgs = Object.values(store.ec2.securityGroups);
      const filtered = filterIds.length ? allSgs.filter(sg => filterIds.includes(sg.id)) : allSgs;
      const sgs = filtered.map(sg => {
        const ingress = sg.ingressRules.map(r =>
          `<item><ipProtocol>${r.protocol}</ipProtocol><fromPort>${r.fromPort}</fromPort><toPort>${r.toPort}</toPort><ipRanges><item><cidrIp>${r.cidr}</cidrIp></item></ipRanges></item>`
        ).join('');
        const egress = sg.egressRules.map(r =>
          `<item><ipProtocol>${r.protocol}</ipProtocol><fromPort>${r.fromPort}</fromPort><toPort>${r.toPort}</toPort><ipRanges><item><cidrIp>${r.cidr}</cidrIp></item></ipRanges></item>`
        ).join('');
        const tagSet = Object.entries(sg.tags || {}).map(([k, v]) =>
          `<item><key>${escapeXml(k)}</key><value>${escapeXml(v)}</value></item>`
        ).join('');
        return `<item>
          <ownerId>123456789012</ownerId>
          <groupId>${sg.id}</groupId>
          <groupName>${escapeXml(sg.name)}</groupName>
          <groupDescription>${escapeXml(sg.description || '')}</groupDescription>
          <vpcId>${sg.vpcId || 'vpc-mockcloud1'}</vpcId>
          <ipPermissions>${ingress}</ipPermissions>
          <ipPermissionsEgress>${egress}</ipPermissionsEgress>
          <tagSet>${tagSet}</tagSet>
        </item>`;
      }).join('');
      return xmlResponse(res, 200, ec2Wrap('DescribeSecurityGroupsResponse', `<securityGroupInfo>${sgs}</securityGroupInfo>`));
    }

    case 'CreateTags': {
      // Tag any resource type by ID
      const resourceIds = getList(params, 'ResourceId');
      const tags = {};
      for (let i = 1; ; i++) {
        const k = params.get(`Tag.${i}.Key`);
        const v = params.get(`Tag.${i}.Value`);
        if (!k) break;
        tags[k] = v || '';
      }
      for (const id of resourceIds) {
        const sg = store.ec2.securityGroups[id];
        if (sg) Object.assign(sg.tags, tags);
        const inst = store.ec2.instances[id];
        if (inst) inst.tags = { ...(inst.tags || {}), ...tags };
        const kp = Object.values(store.ec2.keyPairs).find(k => k.keyId === id || k.name === id);
        if (kp) kp.tags = { ...(kp.tags || {}), ...tags };
      }
      return xmlResponse(res, 200, ec2Wrap('CreateTagsResponse', '<return>true</return>'));
    }

    case 'DescribeSecurityGroupRules': {
      // Return stored ingress+egress rules with synthetic rule IDs
      let sgId = params.get('Filter.1.Value.1');
      for (let f = 1; f <= 5; f++) {
        if (params.get(`Filter.${f}.Name`) === 'group-id') {
          sgId = params.get(`Filter.${f}.Value.1`);
          break;
        }
      }
      const sg = sgId && store.ec2.securityGroups[sgId];
      if (!sg) return xmlResponse(res, 200, ec2Wrap('DescribeSecurityGroupRulesResponse', '<securityGroupRuleSet/>'));
      const rules = [
        ...sg.ingressRules.map((r, i) =>
          `<item><securityGroupRuleId>sgr-in-${sg.id}-${i}</securityGroupRuleId><groupId>${sg.id}</groupId><isEgress>false</isEgress><ipProtocol>${r.protocol}</ipProtocol><fromPort>${r.fromPort}</fromPort><toPort>${r.toPort}</toPort><cidrIpv4>${r.cidr}</cidrIpv4></item>`
        ),
        ...sg.egressRules.map((r, i) =>
          `<item><securityGroupRuleId>sgr-eg-${sg.id}-${i}</securityGroupRuleId><groupId>${sg.id}</groupId><isEgress>true</isEgress><ipProtocol>${r.protocol}</ipProtocol><fromPort>${r.fromPort}</fromPort><toPort>${r.toPort}</toPort><cidrIpv4>${r.cidr}</cidrIpv4></item>`
        ),
      ].join('');
      return xmlResponse(res, 200, ec2Wrap('DescribeSecurityGroupRulesResponse', `<securityGroupRuleSet>${rules}</securityGroupRuleSet>`));
    }

    case 'AuthorizeSecurityGroupIngress': {
      const sgId = params.get('GroupId');
      const sg = store.ec2.securityGroups[sgId];
      if (!sg) return xmlResponse(res, 400, ec2Wrap('ErrorResponse', '<Errors><Error><Code>InvalidGroup.NotFound</Code><Message>Security group not found</Message></Error></Errors>'));
      // Collect all permission entries (Terraform sends IpPermissions.N.* format)
      let i = 1;
      while (params.get(`IpPermissions.${i}.IpProtocol`)) {
        sg.ingressRules.push({
          protocol: params.get(`IpPermissions.${i}.IpProtocol`) || '-1',
          fromPort: params.get(`IpPermissions.${i}.FromPort`) || 0,
          toPort: params.get(`IpPermissions.${i}.ToPort`) || 65535,
          cidr: params.get(`IpPermissions.${i}.IpRanges.1.CidrIp`) || '0.0.0.0/0',
        });
        i++;
      }
      // Also handle flat params (older SDK format)
      if (i === 1 && params.get('IpProtocol')) {
        sg.ingressRules.push({
          protocol: params.get('IpProtocol') || '-1',
          fromPort: params.get('FromPort') || 0,
          toPort: params.get('ToPort') || 65535,
          cidr: params.get('CidrIp') || '0.0.0.0/0',
        });
      }
      return xmlResponse(res, 200, ec2Wrap('AuthorizeSecurityGroupIngressResponse', '<return>true</return>'));
    }

    case 'AuthorizeSecurityGroupEgress': {
      const sgId = params.get('GroupId');
      const sg = store.ec2.securityGroups[sgId];
      if (!sg) return xmlResponse(res, 400, ec2Wrap('ErrorResponse', '<Errors><Error><Code>InvalidGroup.NotFound</Code><Message>Security group not found</Message></Error></Errors>'));
      let i = 1;
      while (params.get(`IpPermissions.${i}.IpProtocol`)) {
        const proto = params.get(`IpPermissions.${i}.IpProtocol`) || '-1';
        const rawFrom = params.get(`IpPermissions.${i}.FromPort`);
        const rawTo   = params.get(`IpPermissions.${i}.ToPort`);
        sg.egressRules.push({
          protocol: proto,
          fromPort: rawFrom != null ? rawFrom : 0,
          toPort:   rawTo   != null ? rawTo   : (proto === '-1' ? 0 : 65535),
          cidr: params.get(`IpPermissions.${i}.IpRanges.1.CidrIp`) || '0.0.0.0/0',
        });
        i++;
      }
      return xmlResponse(res, 200, ec2Wrap('AuthorizeSecurityGroupEgressResponse', '<return>true</return>'));
    }

    case 'RevokeSecurityGroupIngress': {
      const sgId = params.get('GroupId');
      const sg = store.ec2.securityGroups[sgId];
      if (sg) sg.ingressRules = filterRevoked(sg.ingressRules, params);
      return xmlResponse(res, 200, ec2Wrap('RevokeSecurityGroupIngressResponse', '<return>true</return>'));
    }

    case 'RevokeSecurityGroupEgress': {
      const sgId = params.get('GroupId');
      const sg = store.ec2.securityGroups[sgId];
      if (sg) sg.egressRules = filterRevoked(sg.egressRules, params);
      return xmlResponse(res, 200, ec2Wrap('RevokeSecurityGroupEgressResponse', '<return>true</return>'));
    }

    case 'DeleteSecurityGroup': {
      const sgId = params.get('GroupId') || params.get('GroupName');
      // find by id or name
      const found = sgId && (store.ec2.securityGroups[sgId] ||
        Object.values(store.ec2.securityGroups).find(sg => sg.name === sgId));
      if (found) delete store.ec2.securityGroups[found.id];
      return xmlResponse(res, 200, ec2Wrap('DeleteSecurityGroupResponse', '<return>true</return>'));
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

    case 'DeleteKeyPair': {
      const name = params.get('KeyName');
      delete store.ec2.keyPairs[name];
      return xmlResponse(res, 200, ec2Wrap('DeleteKeyPairResponse', '<return>true</return>'));
    }

    case 'ImportKeyPair': {
      const name = params.get('KeyName');
      const keyId = `key-${randomId(8)}`;
      store.ec2.keyPairs[name] = { name, keyId, fingerprint: randomId(20), material: null };
      return xmlResponse(res, 200, ec2Wrap('ImportKeyPairResponse', `<keyName>${escapeXml(name)}</keyName><keyFingerprint>${store.ec2.keyPairs[name].fingerprint}</keyFingerprint>`));
    }

    case 'DescribeVpcs':
      return xmlResponse(res, 200, ec2Wrap('DescribeVpcsResponse',
        `<vpcSet><item><vpcId>vpc-mockcloud1</vpcId><cidrBlock>10.0.0.0/16</cidrBlock><state>available</state><isDefault>true</isDefault></item></vpcSet>`));

    case 'DescribeSubnets':
      return xmlResponse(res, 200, ec2Wrap('DescribeSubnetsResponse',
        `<subnetSet><item><subnetId>subnet-mock0001</subnetId><vpcId>vpc-mockcloud1</vpcId><cidrBlock>10.0.1.0/24</cidrBlock><availabilityZone>us-east-1a</availabilityZone><state>available</state></item></subnetSet>`));

    case 'DescribeInternetGateways':
      return xmlResponse(res, 200, ec2Wrap('DescribeInternetGatewaysResponse',
        `<internetGatewaySet><item><internetGatewayId>igw-mock0001</internetGatewayId><attachmentSet><item><vpcId>vpc-mockcloud1</vpcId><state>available</state></item></attachmentSet></item></internetGatewaySet>`));

    case 'DescribeRouteTables':
      return xmlResponse(res, 200, ec2Wrap('DescribeRouteTablesResponse',
        `<routeTableSet><item><routeTableId>rtb-mock0001</routeTableId><vpcId>vpc-mockcloud1</vpcId></item></routeTableSet>`));

    case 'DescribeInstanceTypes': {
      // Collect requested types from InstanceType.N params or instance-type filter
      const requested = [];
      for (let i = 1; ; i++) {
        const v = params.get(`InstanceType.${i}`);
        if (!v) break;
        requested.push(v);
      }
      // Also check Filter.N.Name=instance-type / Filter.N.Value.M
      for (let f = 1; f <= 10; f++) {
        if (params.get(`Filter.${f}.Name`) === 'instance-type') {
          for (let v = 1; ; v++) {
            const val = params.get(`Filter.${f}.Value.${v}`);
            if (!val) break;
            requested.push(val);
          }
        }
      }
      const types = requested.length
        ? requested.filter(t => INSTANCE_TYPES[t])
        : Object.keys(INSTANCE_TYPES);
      const items = types.map(t => {
        const s = INSTANCE_TYPES[t];
        return `<item>
          <instanceType>${t}</instanceType>
          <currentGeneration>true</currentGeneration>
          <vCpuInfo><defaultVCpus>${s.vcpu}</defaultVCpus><defaultCores>${Math.ceil(s.vcpu/2)}</defaultCores><defaultThreadsPerCore>2</defaultThreadsPerCore></vCpuInfo>
          <memoryInfo><sizeInMiB>${s.mem * 1024}</sizeInMiB></memoryInfo>
          <processorInfo><supportedArchitectures><item>x86_64</item></supportedArchitectures><sustainedClockSpeedInGhz>3.1</sustainedClockSpeedInGhz></processorInfo>
          <networkInfo><networkPerformance>Up to 5 Gigabit</networkPerformance><maximumNetworkInterfaces>3</maximumNetworkInterfaces></networkInfo>
          <hypervisor>nitro</hypervisor>
          <instanceStorageSupported>false</instanceStorageSupported>
          <ebsInfo><ebsOptimizedSupport>default</ebsOptimizedSupport><encryptionSupport>supported</encryptionSupport></ebsInfo>
        </item>`;
      }).join('');
      return xmlResponse(res, 200, ec2Wrap('DescribeInstanceTypesResponse', `<instanceTypeSet>${items}</instanceTypeSet>`));
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

// Parse the IpPermissions.N.* form-encoded shape Terraform / SDK send and
// remove only matching rules from `existing`. Matches by (protocol, fromPort,
// toPort, cidr) — the same tuple AWS uses to identify a rule.
function filterRevoked(existing, params) {
  const toRemove = [];
  for (let i = 1; params.get(`IpPermissions.${i}.IpProtocol`); i++) {
    toRemove.push({
      protocol: params.get(`IpPermissions.${i}.IpProtocol`) || '-1',
      fromPort: params.get(`IpPermissions.${i}.FromPort`) ?? 0,
      toPort:   params.get(`IpPermissions.${i}.ToPort`)   ?? 65535,
      cidr:     params.get(`IpPermissions.${i}.IpRanges.1.CidrIp`) || '0.0.0.0/0',
    });
  }
  // Flat (older SDK) form
  if (!toRemove.length && params.get('IpProtocol')) {
    toRemove.push({
      protocol: params.get('IpProtocol') || '-1',
      fromPort: params.get('FromPort') ?? 0,
      toPort:   params.get('ToPort')   ?? 65535,
      cidr:     params.get('CidrIp')   || '0.0.0.0/0',
    });
  }
  // No rules specified → nothing to remove (AWS would actually error here, but
  // we just no-op rather than silently wiping the whole rule set).
  if (!toRemove.length) return existing;
  return existing.filter(r => !toRemove.some(t =>
    String(t.protocol) === String(r.protocol) &&
    String(t.fromPort) === String(r.fromPort) &&
    String(t.toPort)   === String(r.toPort)   &&
    String(t.cidr)     === String(r.cidr)
  ));
}

