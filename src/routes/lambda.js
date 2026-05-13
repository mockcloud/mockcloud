// routes/lambda.js — /mockcloud/lambda/* UI API
import { store, randomId } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

const body = req => req.parsedBody || {};

export function registerLambdaRoutes(app) {

  app.get('/mockcloud/lambda/functions', (req, res) => {
    jsonResponse(res, 200, {
      functions: Object.values(store.lambda.functions).map(f => ({
        name:        f.name,
        runtime:     f.runtime,
        handler:     f.handler,
        memory:      f.memory,
        timeout:     f.timeout,
        invocations: f.invocations,
        errors:      f.errors,
        created:     f.created,
        lastInvoked: f.lastInvoked,
      })),
    });
  });

  app.get('/mockcloud/lambda/functions/:name', (req, res) => {
    const f = store.lambda.functions[req.params.name];
    if (!f) return errorJson(res, 404, 'NotFound', 'Function not found');
    jsonResponse(res, 200, f);
  });

  app.post('/mockcloud/lambda/functions', (req, res) => {
    const { name, runtime, handler, memory, timeout, env } = body(req);
    if (!name) return errorJson(res, 400, 'ValidationError', 'name required');
    if (store.lambda.functions[name]) return errorJson(res, 409, 'Conflict', 'Function already exists');
    store.lambda.functions[name] = {
      name,
      runtime:     runtime  || 'nodejs20.x',
      handler:     handler  || 'index.handler',
      memory:      memory   || 128,
      timeout:     timeout  || 30,
      env:         env      || {},
      code:        '',
      invocations: 0,
      errors:      0,
      created:     Date.now(),
      lastInvoked: null,
      logs:        [],
    };
    store.addTrail({ method: 'POST', path: `/lambda/${name}`, status: 201, latency: 5 });
    jsonResponse(res, 201, store.lambda.functions[name]);
  });

  app.delete('/mockcloud/lambda/functions/:name', (req, res) => {
    if (!store.lambda.functions[req.params.name])
      return errorJson(res, 404, 'NotFound', 'Function not found');
    delete store.lambda.functions[req.params.name];
    store.addTrail({ method: 'DELETE', path: `/lambda/${req.params.name}`, status: 200, latency: 1 });
    jsonResponse(res, 200, { deleted: req.params.name });
  });

  app.post('/mockcloud/lambda/functions/:name/invoke', async (req, res) => {
    const fn = store.lambda.functions[req.params.name];
    if (!fn) return errorJson(res, 404, 'NotFound', 'Function not found');
    const event = body(req);
    // Use the shared invoker so the UI button runs the same code path as
    // `aws lambda invoke` and downstream triggers (SNS/EventBridge/DDB).
    const { invokeLambda } = await import('../services/lambda.js');
    const outcome = await invokeLambda(req.params.name, event, { source: 'ui' });
    store.addTrail({
      method: 'POST',
      path:   `/lambda/${fn.name}/invocations`,
      status: outcome.error ? 500 : 200,
      latency: outcome.duration,
    });
    if (outcome.error) {
      return jsonResponse(res, 200, {
        requestId:  outcome.requestId,
        statusCode: 500,
        error:      outcome.error,
        duration:   outcome.duration,
        logs:       fn.logs.slice(0, 5),
      });
    }
    let parsed;
    try { parsed = JSON.parse(outcome.result); } catch { parsed = outcome.result; }
    jsonResponse(res, 200, {
      requestId:  outcome.requestId,
      statusCode: 200,
      response:   parsed,
      duration:   outcome.duration,
      logs:       fn.logs.slice(0, 5),
    });
  });

  app.get('/mockcloud/lambda/functions/:name/logs', (req, res) => {
    const fn = store.lambda.functions[req.params.name];
    if (!fn) return errorJson(res, 404, 'NotFound', 'Function not found');
    jsonResponse(res, 200, { logs: fn.logs });
  });
}
