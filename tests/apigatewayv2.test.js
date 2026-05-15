// tests/apigatewayv2.test.js
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CreateApiCommand,
  GetApisCommand,
  GetApiCommand,
  DeleteApiCommand,
  CreateIntegrationCommand,
  GetIntegrationsCommand,
  DeleteIntegrationCommand,
  CreateStageCommand,
  GetStagesCommand,
  DeleteStageCommand,
  CreateRouteCommand,
  GetRoutesCommand,
  DeleteRouteCommand,
} from '@aws-sdk/client-apigatewayv2';
import { startServer } from './helpers/server.js';
import { makeClients } from './helpers/aws.js';

let server, agv2;

before(async () => {
  server = await startServer();
  ({ agv2 } = makeClients(server.endpoint));
});

after(() => server.close());
beforeEach(() => server.resetStore());

// ── APIs ─────────────────────────────────────────────────────────────────────

describe('API CRUD', () => {
  it('CreateApi returns an ApiId', async () => {
    const res = await agv2.send(new CreateApiCommand({ Name: 'my-api', ProtocolType: 'HTTP' }));
    assert.ok(res.ApiId, 'should return ApiId');
    assert.equal(res.Name, 'my-api');
    assert.equal(res.ProtocolType, 'HTTP');
    assert.ok(res.ApiEndpoint, 'should return ApiEndpoint');
  });

  it('GetApis lists created APIs', async () => {
    await agv2.send(new CreateApiCommand({ Name: 'api-one', ProtocolType: 'HTTP' }));
    await agv2.send(new CreateApiCommand({ Name: 'api-two', ProtocolType: 'WEBSOCKET' }));
    const list = await agv2.send(new GetApisCommand({}));
    assert.equal(list.Items.length, 2, 'should list 2 APIs');
  });

  it('GetApi returns a specific API', async () => {
    const created = await agv2.send(new CreateApiCommand({ Name: 'specific-api', ProtocolType: 'HTTP' }));
    const get = await agv2.send(new GetApiCommand({ ApiId: created.ApiId }));
    assert.equal(get.ApiId, created.ApiId);
    assert.equal(get.Name, 'specific-api');
  });

  it('GetApi throws 404 for unknown API', async () => {
    await assert.rejects(
      () => agv2.send(new GetApiCommand({ ApiId: 'nonexistent123' })),
      err => { assert.equal(err.$metadata.httpStatusCode, 404); return true; }
    );
  });

  it('DeleteApi removes the API', async () => {
    const { ApiId } = await agv2.send(new CreateApiCommand({ Name: 'delete-me', ProtocolType: 'HTTP' }));
    await agv2.send(new DeleteApiCommand({ ApiId }));
    const list = await agv2.send(new GetApisCommand({}));
    const found = list.Items.find(a => a.ApiId === ApiId);
    assert.equal(found, undefined, 'deleted API should not appear');
  });
});

// ── Integrations ─────────────────────────────────────────────────────────────

describe('Integration CRUD', () => {
  let apiId;
  beforeEach(async () => {
    const api = await agv2.send(new CreateApiCommand({ Name: 'integ-api', ProtocolType: 'HTTP' }));
    apiId = api.ApiId;
  });

  it('CreateIntegration returns IntegrationId', async () => {
    const res = await agv2.send(new CreateIntegrationCommand({
      ApiId: apiId,
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: 'arn:aws:lambda:us-east-1:123456789012:function:my-fn',
      PayloadFormatVersion: '2.0',
    }));
    assert.ok(res.IntegrationId, 'should return IntegrationId');
    assert.equal(res.IntegrationType, 'AWS_PROXY');
    assert.equal(res.PayloadFormatVersion, '2.0');
  });

  it('GetIntegrations lists integrations', async () => {
    await agv2.send(new CreateIntegrationCommand({
      ApiId: apiId,
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: 'arn:aws:lambda:us-east-1:123456789012:function:fn1',
    }));
    await agv2.send(new CreateIntegrationCommand({
      ApiId: apiId,
      IntegrationType: 'HTTP_PROXY',
      IntegrationUri: 'https://example.com',
    }));
    const list = await agv2.send(new GetIntegrationsCommand({ ApiId: apiId }));
    assert.equal(list.Items.length, 2);
  });

  it('DeleteIntegration removes integration', async () => {
    const { IntegrationId } = await agv2.send(new CreateIntegrationCommand({
      ApiId: apiId,
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: 'arn:aws:lambda:us-east-1:123456789012:function:fn',
    }));
    await agv2.send(new DeleteIntegrationCommand({ ApiId: apiId, IntegrationId }));
    const list = await agv2.send(new GetIntegrationsCommand({ ApiId: apiId }));
    assert.equal(list.Items.length, 0, 'integration list should be empty after delete');
  });
});

// ── Stages ───────────────────────────────────────────────────────────────────

describe('Stage CRUD', () => {
  let apiId;
  beforeEach(async () => {
    const api = await agv2.send(new CreateApiCommand({ Name: 'stage-api', ProtocolType: 'HTTP' }));
    apiId = api.ApiId;
  });

  it('CreateStage returns StageName', async () => {
    const res = await agv2.send(new CreateStageCommand({
      ApiId: apiId,
      StageName: '$default',
      AutoDeploy: true,
    }));
    assert.equal(res.StageName, '$default');
    assert.equal(res.AutoDeploy, true);
  });

  it('GetStages lists created stages', async () => {
    await agv2.send(new CreateStageCommand({ ApiId: apiId, StageName: 'prod', AutoDeploy: false }));
    await agv2.send(new CreateStageCommand({ ApiId: apiId, StageName: 'staging', AutoDeploy: true }));
    const list = await agv2.send(new GetStagesCommand({ ApiId: apiId }));
    assert.equal(list.Items.length, 2);
    const names = list.Items.map(s => s.StageName);
    assert.ok(names.includes('prod'));
    assert.ok(names.includes('staging'));
  });

  it('DeleteStage removes stage', async () => {
    await agv2.send(new CreateStageCommand({ ApiId: apiId, StageName: 'tmp' }));
    await agv2.send(new DeleteStageCommand({ ApiId: apiId, StageName: 'tmp' }));
    const list = await agv2.send(new GetStagesCommand({ ApiId: apiId }));
    assert.equal(list.Items.length, 0);
  });
});

// ── Routes ───────────────────────────────────────────────────────────────────

describe('Route CRUD', () => {
  let apiId, integrationId;
  beforeEach(async () => {
    const api = await agv2.send(new CreateApiCommand({ Name: 'route-api', ProtocolType: 'HTTP' }));
    apiId = api.ApiId;
    const integ = await agv2.send(new CreateIntegrationCommand({
      ApiId: apiId,
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: 'arn:aws:lambda:us-east-1:123456789012:function:fn',
    }));
    integrationId = integ.IntegrationId;
  });

  it('CreateRoute with $default route key', async () => {
    const res = await agv2.send(new CreateRouteCommand({
      ApiId: apiId,
      RouteKey: '$default',
      Target: `integrations/${integrationId}`,
    }));
    assert.ok(res.RouteId, 'should return RouteId');
    assert.equal(res.RouteKey, '$default');
  });

  it('GetRoutes lists routes', async () => {
    await agv2.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: 'GET /users' }));
    await agv2.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: 'POST /users' }));
    const list = await agv2.send(new GetRoutesCommand({ ApiId: apiId }));
    assert.equal(list.Items.length, 2);
  });

  it('DeleteRoute removes route', async () => {
    const { RouteId } = await agv2.send(new CreateRouteCommand({
      ApiId: apiId,
      RouteKey: 'GET /tmp',
    }));
    await agv2.send(new DeleteRouteCommand({ ApiId: apiId, RouteId }));
    const list = await agv2.send(new GetRoutesCommand({ ApiId: apiId }));
    assert.equal(list.Items.length, 0);
  });
});

// ── Full serverless-lambda Terraform workflow ─────────────────────────────────

describe('Serverless Lambda Terraform workflow', () => {
  it('creates API → integration → stage → route in sequence', async () => {
    // 1. Create API (aws_apigatewayv2_api)
    const api = await agv2.send(new CreateApiCommand({
      Name: 'serverless-api',
      ProtocolType: 'HTTP',
    }));
    assert.ok(api.ApiId);

    // 2. Create integration (aws_apigatewayv2_integration)
    const integ = await agv2.send(new CreateIntegrationCommand({
      ApiId: api.ApiId,
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: 'arn:aws:lambda:us-east-1:123456789012:function:handler',
      PayloadFormatVersion: '2.0',
      IntegrationMethod: 'POST',
    }));
    assert.ok(integ.IntegrationId);

    // 3. Create stage (aws_apigatewayv2_stage)
    const stage = await agv2.send(new CreateStageCommand({
      ApiId: api.ApiId,
      StageName: '$default',
      AutoDeploy: true,
    }));
    assert.equal(stage.StageName, '$default');

    // 4. Create route (aws_apigatewayv2_route)
    const route = await agv2.send(new CreateRouteCommand({
      ApiId: api.ApiId,
      RouteKey: '$default',
      Target: `integrations/${integ.IntegrationId}`,
    }));
    assert.ok(route.RouteId);

    // 5. Verify everything is queryable (terraform refresh would do this)
    const apiGet = await agv2.send(new GetApiCommand({ ApiId: api.ApiId }));
    assert.equal(apiGet.Name, 'serverless-api');

    const stages = await agv2.send(new GetStagesCommand({ ApiId: api.ApiId }));
    assert.equal(stages.Items.length, 1);

    const routes = await agv2.send(new GetRoutesCommand({ ApiId: api.ApiId }));
    assert.equal(routes.Items.length, 1);
  });
});
