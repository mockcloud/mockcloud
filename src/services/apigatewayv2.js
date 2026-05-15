// services/apigatewayv2.js — API Gateway v2 (HTTP APIs) emulator
// Handles /v2/apis, /v2/apis/:id/integrations, /v2/apis/:id/stages
// Used by Terraform aws_apigatewayv2_api, aws_apigatewayv2_integration,
// aws_apigatewayv2_stage, aws_apigatewayv2_route resources.

import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson, getRawBody } from '../middleware/response.js';

// Ensure v2 namespace exists in store
function getV2Store() {
  if (!store.apigateway.v2) {
    store.apigateway.v2 = { apis: {} };
  }
  return store.apigateway.v2;
}

export async function handler(req, res) {
  const url    = new URL(req.url, 'http://localhost');
  const parts  = url.pathname.split('/').filter(Boolean); // ['v2','apis',...] or ['2015-07-09','apis',...]
  const method = req.method;
  const body   = getRawBody(req);
  let payload  = {};
  try { payload = JSON.parse(body); } catch {}

  const v2 = getV2Store();

  // Normalise: strip leading 'v2' or version segment
  // Paths can be /v2/apis or /2015-07-09/apis (Terraform uses versioned path)
  const apiIndex = parts.indexOf('apis');
  if (apiIndex === -1) return errorJson(res, 404, 'NotFoundException', 'Not found');
  const segments = parts.slice(apiIndex); // ['apis', apiId?, 'integrations'?, integrationId?, ...]

  const [, apiId, subResource, subId] = segments;

  // ── GET /apis — list APIs ────────────────────────────────────────────────
  if (method === 'GET' && !apiId) {
    return jsonResponse(res, 200, { items: Object.values(v2.apis).map(publicApi) });
  }

  // ── POST /apis — create API ──────────────────────────────────────────────
  if (method === 'POST' && !apiId) {
    const id = randomId(10);
    const api = {
      apiId:                       id,
      name:                        payload.Name || payload.name || 'api',
      protocolType:                payload.ProtocolType || payload.protocolType || 'HTTP',
      apiEndpoint:                 `http://localhost:4566/execute-api/${id}`,
      apiKeySelectionExpression:   payload.ApiKeySelectionExpression || '$request.header.x-api-key',
      routeSelectionExpression:    payload.RouteSelectionExpression || '$request.method $request.path',
      createdDate:                 new Date().toISOString(),
      tags:                        payload.Tags || payload.tags || {},
      integrations: {},
      stages:       {},
      routes:       {},
    };
    v2.apis[id] = api;
    return jsonResponse(res, 201, publicApi(api));
  }

  // ── GET /apis/:id ────────────────────────────────────────────────────────
  if (method === 'GET' && apiId && !subResource) {
    const api = v2.apis[apiId];
    if (!api) return errorJson(res, 404, 'NotFoundException', `API ${apiId} not found`);
    return jsonResponse(res, 200, publicApi(api));
  }

  // ── DELETE /apis/:id ─────────────────────────────────────────────────────
  if (method === 'DELETE' && apiId && !subResource) {
    delete v2.apis[apiId];
    res.writeHead(204); res.end(); return;
  }

  // ── PATCH /apis/:id — update API ─────────────────────────────────────────
  if (method === 'PATCH' && apiId && !subResource) {
    const api = v2.apis[apiId];
    if (!api) return errorJson(res, 404, 'NotFoundException', `API ${apiId} not found`);
    if (payload.Name || payload.name) api.name = payload.Name || payload.name;
    return jsonResponse(res, 200, publicApi(api));
  }

  const api = v2.apis[apiId];
  if (apiId && !api) return errorJson(res, 404, 'NotFoundException', `API ${apiId} not found`);

  // ── Integrations ─────────────────────────────────────────────────────────
  if (subResource === 'integrations') {
    if (method === 'GET' && !subId) {
      return jsonResponse(res, 200, { items: Object.values(api.integrations) });
    }
    if (method === 'POST' && !subId) {
      const id = randomId(8);
      const integration = {
        integrationId:      id,
        integrationType:    payload.IntegrationType || payload.integrationType || 'AWS_PROXY',
        integrationUri:     payload.IntegrationUri || payload.integrationUri || '',
        integrationMethod:  payload.IntegrationMethod || payload.integrationMethod || 'POST',
        payloadFormatVersion: payload.PayloadFormatVersion || payload.payloadFormatVersion || '2.0',
      };
      api.integrations[id] = integration;
      return jsonResponse(res, 201, integration);
    }
    if (method === 'GET' && subId) {
      const i = api.integrations[subId];
      if (!i) return errorJson(res, 404, 'NotFoundException', 'Integration not found');
      return jsonResponse(res, 200, i);
    }
    if (method === 'DELETE' && subId) {
      delete api.integrations[subId];
      res.writeHead(204); res.end(); return;
    }
    if (method === 'PATCH' && subId) {
      const i = api.integrations[subId];
      if (!i) return errorJson(res, 404, 'NotFoundException', 'Integration not found');
      Object.assign(i, payload);
      return jsonResponse(res, 200, i);
    }
  }

  // ── Stages ───────────────────────────────────────────────────────────────
  if (subResource === 'stages') {
    if (method === 'GET' && !subId) {
      return jsonResponse(res, 200, { items: Object.values(api.stages) });
    }
    if (method === 'POST' && !subId) {
      const name = payload.StageName || payload.stageName || '$default';
      const stage = makeStage(api.apiId, name, payload);
      api.stages[name] = stage;
      return jsonResponse(res, 201, stage);
    }
    if (method === 'GET' && subId) {
      const key = decodeURIComponent(subId);
      const s = api.stages[key] || api.stages[subId];
      if (!s) return errorJson(res, 404, 'NotFoundException', 'Stage not found');
      return jsonResponse(res, 200, s);
    }
    if (method === 'DELETE' && subId) {
      const key = decodeURIComponent(subId);
      delete api.stages[key];
      delete api.stages[subId];
      res.writeHead(204); res.end(); return;
    }
    if (method === 'PATCH' && subId) {
      const key = decodeURIComponent(subId);
      const s = api.stages[key] || api.stages[subId];
      if (!s) return errorJson(res, 404, 'NotFoundException', 'Stage not found');
      Object.assign(s, payload);
      return jsonResponse(res, 200, s);
    }
  }

  // ── Routes ───────────────────────────────────────────────────────────────
  if (subResource === 'routes') {
    if (method === 'GET' && !subId) {
      return jsonResponse(res, 200, { items: Object.values(api.routes) });
    }
    if (method === 'POST' && !subId) {
      const id = randomId(8);
      const route = {
        routeId:    id,
        routeKey:   payload.RouteKey || payload.routeKey || '$default',
        target:     payload.Target || payload.target || '',
        apiKeyRequired: false,
      };
      api.routes[id] = route;
      return jsonResponse(res, 201, route);
    }
    if (method === 'GET' && subId) {
      const r = api.routes[subId];
      if (!r) return errorJson(res, 404, 'NotFoundException', 'Route not found');
      return jsonResponse(res, 200, r);
    }
    if (method === 'PATCH' && subId) {
      const r = api.routes[subId];
      if (!r) return errorJson(res, 404, 'NotFoundException', 'Route not found');
      Object.assign(r, payload);
      return jsonResponse(res, 200, r);
    }
    if (method === 'DELETE' && subId) {
      delete api.routes[subId];
      res.writeHead(204); res.end(); return;
    }
  }

  // ── Deployments (Terraform may call this) ────────────────────────────────
  if (subResource === 'deployments') {
    if (method === 'POST') {
      const deployId = randomId(10);
      return jsonResponse(res, 201, { deploymentId: deployId, deploymentStatus: 'DEPLOYED', createdDate: new Date().toISOString() });
    }
    if (method === 'GET') {
      return jsonResponse(res, 200, { items: [] });
    }
  }

  return errorJson(res, 400, 'BadRequestException', 'Unknown API Gateway v2 operation');
}

function makeStage(apiId, name, payload = {}) {
  return {
    stageName:       name,
    autoDeploy:      payload.AutoDeploy ?? payload.autoDeploy ?? true,
    invokeUrl:       `http://localhost:4566/execute-api/${apiId}/${name}`,
    createdDate:     new Date().toISOString(),
    lastUpdatedDate: new Date().toISOString(),
    defaultRouteSettings: {},
    routeSettings:   {},
    stageVariables:  payload.StageVariables || payload.stageVariables || {},
    tags:            payload.Tags || payload.tags || {},
  };
}

function publicApi(api) {
  const { integrations, stages, routes, ...pub } = api;
  return pub;
}