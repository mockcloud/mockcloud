// services/stepfunctions.js — AWS Step Functions emulator
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

function parseBody(req) {
  try { return JSON.parse(req.rawBody || '{}'); } catch { return {}; }
}

const TARGET_MAP = {
  'AWSStepFunctions.CreateStateMachine':   createStateMachine,
  'AWSStepFunctions.DeleteStateMachine':   deleteStateMachine,
  'AWSStepFunctions.DescribeStateMachine': describeStateMachine,
  'AWSStepFunctions.ListStateMachines':    listStateMachines,
  'AWSStepFunctions.UpdateStateMachine':   updateStateMachine,
  'AWSStepFunctions.StartExecution':       startExecution,
  'AWSStepFunctions.StopExecution':        stopExecution,
  'AWSStepFunctions.DescribeExecution':    describeExecution,
  'AWSStepFunctions.ListExecutions':       listExecutions,
  'AWSStepFunctions.GetExecutionHistory':  getExecutionHistory,
  'AWSStepFunctions.TagResource':          (req, res) => jsonResponse(res, 200, {}),
  'AWSStepFunctions.ListTagsForResource':  (req, res) => jsonResponse(res, 200, { tags: [] }),
};

export function handler(req, res) {
  const target = req.headers['x-amz-target'] || '';
  const fn = TARGET_MAP[target];
  if (fn) return fn(req, res);
  return errorJson(res, 400, 'InvalidAction', `Unknown Step Functions action: ${target}`);
}

function createStateMachine(req, res) {
  const b = parseBody(req);
  if (!b.name) return errorJson(res, 400, 'ValidationException', 'name required');
  if (store.stepfunctions.stateMachines[b.name])
    return errorJson(res, 400, 'StateMachineAlreadyExists', `State machine ${b.name} already exists`);
  const smArn = arn('states', `stateMachine:${b.name}`);
  store.stepfunctions.stateMachines[b.name] = {
    name:       b.name,
    arn:        smArn,
    definition: b.definition || '{}',
    roleArn:    b.roleArn || arn('iam', 'role/StatesRole'),
    type:       b.type || 'STANDARD',
    status:     'ACTIVE',
    created:    Date.now(),
    executions: [],
  };
  store.addTrail({ method: 'POST', path: `/states/${b.name}`, status: 200, latency: 5 });
  jsonResponse(res, 200, { stateMachineArn: smArn, creationDate: Date.now() / 1000 });
}

function deleteStateMachine(req, res) {
  const b = parseBody(req);
  const name = b.stateMachineArn?.split(':').pop();
  delete store.stepfunctions.stateMachines[name];
  jsonResponse(res, 200, {});
}

function describeStateMachine(req, res) {
  const b    = parseBody(req);
  const name = b.stateMachineArn?.split(':').pop();
  const sm   = store.stepfunctions.stateMachines[name];
  if (!sm) return errorJson(res, 400, 'StateMachineDoesNotExist', `State machine not found`);
  jsonResponse(res, 200, { ...sm, creationDate: sm.created / 1000 });
}

function listStateMachines(req, res) {
  jsonResponse(res, 200, {
    stateMachines: Object.values(store.stepfunctions.stateMachines).map(sm => ({
      name: sm.name, stateMachineArn: sm.arn, type: sm.type,
      creationDate: sm.created / 1000, status: sm.status,
    })),
  });
}

function updateStateMachine(req, res) {
  const b    = parseBody(req);
  const name = b.stateMachineArn?.split(':').pop();
  const sm   = store.stepfunctions.stateMachines[name];
  if (!sm) return errorJson(res, 400, 'StateMachineDoesNotExist', 'State machine not found');
  if (b.definition) sm.definition = b.definition;
  if (b.roleArn)    sm.roleArn    = b.roleArn;
  jsonResponse(res, 200, { updateDate: Date.now() / 1000 });
}

async function startExecution(req, res) {
  const b = parseBody(req);
  const name = b.stateMachineArn?.split(':').pop();
  const sm   = store.stepfunctions.stateMachines[name];
  if (!sm) return errorJson(res, 400, 'StateMachineDoesNotExist', 'State machine not found');

  const execName  = b.name || `exec-${randomId(8)}`;
  const execArn   = arn('states', `execution:${name}:${execName}`);
  const execution = {
    name:             execName,
    executionArn:     execArn,
    stateMachineArn:  sm.arn,
    input:            b.input || '{}',
    status:           'RUNNING',
    startDate:        Date.now() / 1000,
    stopDate:         null,
    output:           null,
    history:          [
      { timestamp: Date.now() / 1000, type: 'ExecutionStarted', executionStartedEventDetails: { input: b.input || '{}' } },
    ],
  };

  sm.executions.unshift(execution);
  store.stepfunctions.executions[execArn] = execution;
  store.addTrail({ method: 'POST', path: `/states/${name}/start`, status: 200, latency: 10 });

  // Simulate execution completing after 500ms
  setTimeout(() => {
    execution.status   = 'SUCCEEDED';
    execution.stopDate = Date.now() / 1000;
    execution.output   = b.input || '{}';
    execution.history.push({ timestamp: Date.now() / 1000, type: 'ExecutionSucceeded', executionSucceededEventDetails: { output: execution.output } });
  }, 500 + Math.random() * 1000);

  jsonResponse(res, 200, { executionArn: execArn, startDate: execution.startDate });
}

function stopExecution(req, res) {
  const b   = parseBody(req);
  const exec = store.stepfunctions.executions[b.executionArn];
  if (exec) { exec.status = 'ABORTED'; exec.stopDate = Date.now() / 1000; }
  jsonResponse(res, 200, { stopDate: Date.now() / 1000 });
}

function describeExecution(req, res) {
  const b    = parseBody(req);
  const exec = store.stepfunctions.executions[b.executionArn];
  if (!exec) return errorJson(res, 400, 'ExecutionDoesNotExist', 'Execution not found');
  jsonResponse(res, 200, exec);
}

function listExecutions(req, res) {
  const b    = parseBody(req);
  const name = b.stateMachineArn?.split(':').pop();
  const sm   = store.stepfunctions.stateMachines[name];
  if (!sm) return errorJson(res, 400, 'StateMachineDoesNotExist', 'State machine not found');
  const execs = sm.executions
    .filter(e => !b.statusFilter || e.status === b.statusFilter)
    .map(e => ({ name: e.name, executionArn: e.executionArn, stateMachineArn: e.stateMachineArn, status: e.status, startDate: e.startDate, stopDate: e.stopDate }));
  jsonResponse(res, 200, { executions: execs });
}

function getExecutionHistory(req, res) {
  const b    = parseBody(req);
  const exec = store.stepfunctions.executions[b.executionArn];
  if (!exec) return errorJson(res, 400, 'ExecutionDoesNotExist', 'Execution not found');
  jsonResponse(res, 200, { events: exec.history.map((e, i) => ({ id: i + 1, ...e })) });
}
