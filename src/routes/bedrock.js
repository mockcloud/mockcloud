// routes/bedrock.js — /mockcloud/bedrock control plane
//
// Lets callers script the canned Bedrock responses + fault injection that
// services/bedrock.js serves. A "rule" matches on model (glob) + prompt
// substring and returns a fixed completion or an error.
import { store, randomId } from '../store.js';
import { jsonResponse } from '../middleware/response.js';

const body = req => req.parsedBody || {};

export function registerBedrockRoutes(app) {
  // Current config + recent invocations.
  app.get('/mockcloud/bedrock', (req, res) => {
    jsonResponse(res, 200, {
      defaultResponse: store.bedrock.defaultResponse,
      rules:           store.bedrock.rules,
      invocations:     store.bedrock.invocations.slice(0, 50),
    });
  });

  // Set the fallback completion text (used when no rule matches).
  app.put('/mockcloud/bedrock', (req, res) => {
    const b = body(req);
    if (typeof b.defaultResponse === 'string') store.bedrock.defaultResponse = b.defaultResponse;
    jsonResponse(res, 200, { defaultResponse: store.bedrock.defaultResponse });
  });

  // Append a rule: { model?, promptContains?, response?, fault? }.
  app.post('/mockcloud/bedrock/rules', (req, res) => {
    const b = body(req);
    const rule = {
      id:             randomId(8),
      model:          b.model || null,
      promptContains: b.promptContains || null,
      response:       typeof b.response === 'string' ? b.response : undefined,
      fault:          b.fault || null,
    };
    store.bedrock.rules.push(rule);
    jsonResponse(res, 201, rule);
  });

  // Clear all rules.
  app.delete('/mockcloud/bedrock/rules', (req, res) => {
    store.bedrock.rules = [];
    jsonResponse(res, 200, { cleared: true });
  });

  // Reset the whole Bedrock namespace (rules + default + invocation log).
  app.delete('/mockcloud/bedrock', (req, res) => {
    store.reset('bedrock');
    jsonResponse(res, 200, { reset: true });
  });
}
