// routes/stepfunctions.js — /mockcloud/sfn/* UI API
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

const body = req => req.parsedBody || {};

export function registerStepFunctionsRoutes(app) {

  app.get('/mockcloud/sfn/statemachines', (req, res) => {
    jsonResponse(res, 200, {
      stateMachines: Object.values(store.stepfunctions.stateMachines).map(sm => ({
        name:         sm.name,
        arn:          sm.arn,
        type:         sm.type,
        status:       sm.status,
        created:      sm.created,
        execCount:    sm.executions.length,
        runningCount: sm.executions.filter(e => e.status === 'RUNNING').length,
      })),
    });
  });

  app.get('/mockcloud/sfn/statemachines/:name/executions', (req, res) => {
    const sm = store.stepfunctions.stateMachines[req.params.name];
    if (!sm) return errorJson(res, 404, 'NotFound', 'State machine not found');
    jsonResponse(res, 200, { executions: sm.executions });
  });

  app.post('/mockcloud/sfn/statemachines', (req, res) => {
    const { name, definition, type } = body(req);
    if (!name) return errorJson(res, 400, 'ValidationError', 'name required');
    if (store.stepfunctions.stateMachines[name])
      return errorJson(res, 409, 'Conflict', 'State machine already exists');
    const smArn = arn('states', `stateMachine:${name}`);
    store.stepfunctions.stateMachines[name] = {
      name, arn: smArn,
      definition: definition || '{"Comment":"MockCloud state machine","StartAt":"Start","States":{"Start":{"Type":"Pass","End":true}}}',
      type: type || 'STANDARD',
      status: 'ACTIVE',
      created: Date.now(),
      executions: [],
    };
    store.addTrail({ method: 'POST', path: `/sfn/${name}`, status: 201, latency: 5 });
    jsonResponse(res, 201, store.stepfunctions.stateMachines[name]);
  });

  app.post('/mockcloud/sfn/statemachines/:name/executions', (req, res) => {
    const sm = store.stepfunctions.stateMachines[req.params.name];
    if (!sm) return errorJson(res, 404, 'NotFound', 'State machine not found');
    const { name: execName, input } = body(req);
    const finalName = execName || `exec-${randomId(8)}`;
    if (sm.executions.some(e => e.name === finalName)) {
      return errorJson(res, 409, 'Conflict', 'Execution name already in use');
    }
    const inputStr = typeof input === 'string' ? input : JSON.stringify(input || {});
    const exec = {
      name:      finalName,
      arn:       `${sm.arn}:execution:${finalName}`,
      stateMachineArn: sm.arn,
      status:    'RUNNING',
      input:     inputStr,
      output:    null,
      startDate: Date.now() / 1000,
      stopDate:  null,
    };
    sm.executions.push(exec);

    // Simulate execution: try to walk the definition's Pass/Wait/Succeed/Fail
    // states; otherwise mark complete after a short delay. Real Lambda-task
    // execution lives in services/stepfunctions.js — this UI path stays
    // intentionally simple and just produces a synthetic terminal state.
    setTimeout(() => {
      try {
        const def = typeof sm.definition === 'string' ? JSON.parse(sm.definition) : sm.definition;
        const hasFail = JSON.stringify(def).includes('"Type":"Fail"');
        exec.status   = hasFail ? 'FAILED' : 'SUCCEEDED';
        exec.output   = hasFail ? null : inputStr;
        exec.stopDate = Date.now() / 1000;
      } catch {
        exec.status   = 'SUCCEEDED';
        exec.output   = inputStr;
        exec.stopDate = Date.now() / 1000;
      }
    }, 600);

    store.addTrail({ method: 'POST', path: `/sfn/${sm.name}/executions/${finalName}`, status: 200, latency: 5 });
    jsonResponse(res, 201, { name: exec.name, arn: exec.arn, startDate: exec.startDate });
  });

  app.get('/mockcloud/sfn/statemachines/:name/executions/:execName', (req, res) => {
    const sm = store.stepfunctions.stateMachines[req.params.name];
    if (!sm) return errorJson(res, 404, 'NotFound', 'State machine not found');
    const exec = sm.executions.find(e => e.name === req.params.execName);
    if (!exec) return errorJson(res, 404, 'NotFound', 'Execution not found');
    jsonResponse(res, 200, exec);
  });

  app.delete('/mockcloud/sfn/statemachines/:name', (req, res) => {
    if (!store.stepfunctions.stateMachines[req.params.name])
      return errorJson(res, 404, 'NotFound', 'State machine not found');
    delete store.stepfunctions.stateMachines[req.params.name];
    jsonResponse(res, 200, { deleted: req.params.name });
  });
}
