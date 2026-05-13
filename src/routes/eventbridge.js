// routes/eventbridge.js — /mockcloud/eventbridge/* UI API
import { store } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';

const body = req => req.parsedBody || {};

export function registerEventBridgeRoutes(app) {

  app.get('/mockcloud/eventbridge/buses', (req, res) => {
    jsonResponse(res, 200, { buses: Object.values(store.eventbridge.buses).map(b => ({
      name:      b.name,
      ruleCount: Object.keys(b.rules).length,
    }))});
  });

  app.get('/mockcloud/eventbridge/buses/:bus/rules', (req, res) => {
    const bus = store.eventbridge.buses[req.params.bus];
    if (!bus) return errorJson(res, 404, 'NotFound', 'Bus not found');
    jsonResponse(res, 200, {
      rules: Object.values(bus.rules).map(r => ({
        name:               r.Name,
        arn:                r.Arn,
        state:              r.State,
        scheduleExpression: r.ScheduleExpression,
        eventPattern:       r.EventPattern,
        targetCount:        r.targets?.length || 0,
        created:            r.created,
      })),
    });
  });

  app.get('/mockcloud/eventbridge/events', (req, res) => {
    const limit = parseInt(req.query?.limit || '100');
    jsonResponse(res, 200, { events: store.eventbridge.events.slice(0, limit) });
  });

  app.delete('/mockcloud/eventbridge/buses/:bus/rules/:name', (req, res) => {
    const bus = store.eventbridge.buses[req.params.bus];
    if (!bus) return errorJson(res, 404, 'NotFound', 'Bus not found');
    delete bus.rules[req.params.name];
    jsonResponse(res, 200, { deleted: req.params.name });
  });
}
