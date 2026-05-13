// routes/terminal.js — /mockcloud/terminal/* UI API
import { jsonResponse, errorJson } from '../middleware/response.js';

const body = req => req.parsedBody || {};

export function registerTerminalRoutes(app) {

  app.post('/mockcloud/terminal/sessions', async (req, res) => {
    const { type, instanceId } = body(req);
    if (!type) return errorJson(res, 400, 'ValidationError', 'type required (ec2 | cli)');
    try {
      const { createSession } = await import('../services/terminal.js');
      const sessionId = createSession(type, instanceId);
      jsonResponse(res, 201, { sessionId });
    } catch (e) {
      errorJson(res, 400, 'TerminalError', e.message);
    }
  });

  app.get('/mockcloud/terminal/sessions/:id/stream', async (req, res) => {
    const { subscribe, unsubscribe, getSession } = await import('../services/terminal.js');
    const session = getSession(req.params.id);
    if (!session) return errorJson(res, 404, 'NotFound', 'Session not found');

    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send     = chunk => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    const buffered = subscribe(req.params.id, send);
    buffered.forEach(send);

    if (session.closed) { res.end(); return; }
    req.on('close', () => unsubscribe(req.params.id, send));
  });

  app.post('/mockcloud/terminal/sessions/:id/exec', async (req, res) => {
    const { execCommand } = await import('../services/terminal.js');
    const { command } = body(req);
    if (!command) return errorJson(res, 400, 'ValidationError', 'command required');
    try {
      execCommand(req.params.id, command);
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      errorJson(res, 400, 'Error', e.message);
    }
  });

  app.post('/mockcloud/terminal/sessions/:id/interrupt', async (req, res) => {
    const { interrupt } = await import('../services/terminal.js');
    interrupt(req.params.id);
    jsonResponse(res, 200, { ok: true });
  });

  app.delete('/mockcloud/terminal/sessions/:id', async (req, res) => {
    const { closeSession } = await import('../services/terminal.js');
    closeSession(req.params.id);
    jsonResponse(res, 200, { closed: true });
  });
}
