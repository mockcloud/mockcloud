// tests/ec2.test.js
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  CreateSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  AuthorizeSecurityGroupIngressCommand,
  AuthorizeSecurityGroupEgressCommand,
  DeleteSecurityGroupCommand,
  CreateKeyPairCommand,
  DescribeKeyPairsCommand,
  DeleteKeyPairCommand,
  ImportKeyPairCommand,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  RunInstancesCommand,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, ec2;

beforeAll(async () => {
  server = await startServer();
  ({ ec2 } = makeClients(server.endpoint));
});

afterAll(() => server.close());
beforeEach(() => server.resetStore());

// ── Security Groups ──────────────────────────────────────────────────────────

describe('Security Groups', () => {
  it('CreateSecurityGroup returns a groupId', async () => {
    const res = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: 'test-sg',
      Description: 'test security group',
    }));
    assert.ok(res.GroupId, 'should return a GroupId');
    assert.match(res.GroupId, /^sg-/, 'GroupId should start with sg-');
  });

  it('DescribeSecurityGroups returns created group', async () => {
    const create = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: 'my-sg',
      Description: 'desc',
    }));
    const list = await ec2.send(new DescribeSecurityGroupsCommand({}));
    const found = list.SecurityGroups.find(sg => sg.GroupId === create.GroupId);
    assert.ok(found, 'created SG should appear in DescribeSecurityGroups');
    assert.equal(found.GroupName, 'my-sg');
    assert.equal(found.Description, 'desc');
  });

  it('AuthorizeSecurityGroupIngress adds inbound rules', async () => {
    const { GroupId } = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: 'web-sg', Description: 'web',
    }));
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId,
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: 80,
        ToPort: 80,
        IpRanges: [{ CidrIp: '0.0.0.0/0' }],
      }],
    }));
    const list = await ec2.send(new DescribeSecurityGroupsCommand({}));
    const sg = list.SecurityGroups.find(s => s.GroupId === GroupId);
    assert.ok(sg, 'SG should exist');
    assert.ok(Array.isArray(sg.IpPermissions), 'IpPermissions should be an array');
    assert.equal(sg.IpPermissions.length, 1, 'should have 1 ingress rule');
    assert.equal(sg.IpPermissions[0].FromPort, 80);
    assert.equal(sg.IpPermissions[0].IpProtocol, 'tcp');
  });

  it('AuthorizeSecurityGroupIngress supports multiple rules', async () => {
    const { GroupId } = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: 'multi-sg', Description: 'multi',
    }));
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId,
      IpPermissions: [
        { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
        { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
      ],
    }));
    const list = await ec2.send(new DescribeSecurityGroupsCommand({}));
    const sg = list.SecurityGroups.find(s => s.GroupId === GroupId);
    assert.equal(sg.IpPermissions.length, 2, 'should have 2 ingress rules');
  });

  it('AuthorizeSecurityGroupEgress adds outbound rules', async () => {
    const { GroupId } = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: 'egress-sg', Description: 'egress',
    }));
    await ec2.send(new AuthorizeSecurityGroupEgressCommand({
      GroupId,
      IpPermissions: [{
        IpProtocol: '-1',
        FromPort: -1,
        ToPort: -1,
        IpRanges: [{ CidrIp: '0.0.0.0/0' }],
      }],
    }));
    const list = await ec2.send(new DescribeSecurityGroupsCommand({}));
    const sg = list.SecurityGroups.find(s => s.GroupId === GroupId);
    assert.ok(sg.IpPermissionsEgress?.length >= 1, 'should have egress rules');
  });

  it('DeleteSecurityGroup removes the group', async () => {
    const { GroupId } = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: 'delete-me', Description: 'temp',
    }));
    await ec2.send(new DeleteSecurityGroupCommand({ GroupId }));
    const list = await ec2.send(new DescribeSecurityGroupsCommand({}));
    const found = list.SecurityGroups.find(sg => sg.GroupId === GroupId);
    assert.equal(found, undefined, 'deleted SG should not appear');
  });

  it('DeleteSecurityGroup on non-existent SG does not throw', async () => {
    // MockCloud returns success for idempotent deletes (matches AWS behaviour on destroy)
    await assert.doesNotReject(
      () => ec2.send(new DeleteSecurityGroupCommand({ GroupId: 'sg-doesnotexist' }))
    );
  });
});

// ── Key Pairs ────────────────────────────────────────────────────────────────

describe('Key Pairs', () => {
  it('CreateKeyPair returns key material', async () => {
    const res = await ec2.send(new CreateKeyPairCommand({ KeyName: 'my-key' }));
    assert.equal(res.KeyName, 'my-key');
    assert.ok(res.KeyFingerprint, 'should have fingerprint');
    assert.ok(res.KeyMaterial?.includes('BEGIN RSA PRIVATE KEY'), 'should have PEM material');
  });

  it('DescribeKeyPairs returns created key', async () => {
    await ec2.send(new CreateKeyPairCommand({ KeyName: 'listed-key' }));
    const list = await ec2.send(new DescribeKeyPairsCommand({}));
    const found = list.KeyPairs.find(k => k.KeyName === 'listed-key');
    assert.ok(found, 'key should appear in DescribeKeyPairs');
    assert.ok(found.KeyFingerprint, 'key should have fingerprint');
  });

  it('DeleteKeyPair removes the key', async () => {
    await ec2.send(new CreateKeyPairCommand({ KeyName: 'disposable-key' }));
    await ec2.send(new DeleteKeyPairCommand({ KeyName: 'disposable-key' }));
    const list = await ec2.send(new DescribeKeyPairsCommand({}));
    const found = list.KeyPairs.find(k => k.KeyName === 'disposable-key');
    assert.equal(found, undefined, 'deleted key should not appear');
  });

  it('ImportKeyPair stores the key without material', async () => {
    const res = await ec2.send(new ImportKeyPairCommand({
      KeyName: 'imported-key',
      PublicKeyMaterial: Buffer.from('ssh-rsa AAAA fake-pub-key'),
    }));
    assert.equal(res.KeyName, 'imported-key');
    const list = await ec2.send(new DescribeKeyPairsCommand({}));
    const found = list.KeyPairs.find(k => k.KeyName === 'imported-key');
    assert.ok(found, 'imported key should appear in DescribeKeyPairs');
  });
});

// ── VPC / Network stubs ──────────────────────────────────────────────────────

describe('VPC and Network stubs', () => {
  it('DescribeVpcs returns a default VPC', async () => {
    const res = await ec2.send(new DescribeVpcsCommand({}));
    assert.ok(res.Vpcs?.length >= 1, 'should return at least one VPC');
    const def = res.Vpcs.find(v => v.IsDefault);
    assert.ok(def, 'should have a default VPC');
  });

  it('DescribeSubnets returns subnets', async () => {
    const res = await ec2.send(new DescribeSubnetsCommand({}));
    assert.ok(res.Subnets?.length >= 1, 'should return at least one subnet');
    assert.ok(res.Subnets[0].SubnetId, 'subnet should have an ID');
  });
});

// ── Instance basics ───────────────────────────────────────────────────────────

describe('EC2 Instances (simulated mode)', () => {
  it('RunInstances creates an instance', async () => {
    const res = await ec2.send(new RunInstancesCommand({
      ImageId: 'ami-ubuntu-22',
      InstanceType: 't3.micro',
      MinCount: 1,
      MaxCount: 1,
    }));
    assert.ok(res.Instances?.length === 1, 'should create 1 instance');
    assert.match(res.Instances[0].InstanceId, /^i-/, 'instance ID should start with i-');
  });

  it('DescribeInstances returns running instances', async () => {
    await ec2.send(new RunInstancesCommand({
      ImageId: 'ami-ubuntu-22', InstanceType: 't3.micro', MinCount: 1, MaxCount: 1,
    }));
    const list = await ec2.send(new DescribeInstancesCommand({}));
    const instances = list.Reservations.flatMap(r => r.Instances);
    assert.ok(instances.length >= 1, 'should have at least 1 instance');
  });
});
