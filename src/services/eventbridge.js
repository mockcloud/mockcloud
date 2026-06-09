// services/eventbridge.js — AWS EventBridge emulator
// Supports PutRule, PutTargets, PutEvents, ListRules, DescribeRule, DeleteRule,
// RemoveTargets, ListTargetsByRule — with actual event firing to Lambda targets
import { store, randomId, arn } from '../store.js';
import { jsonResponse, errorJson } from '../middleware/response.js';
import { registerTick } from '../lifecycle.js';

function parseBody(req) {
  try { return JSON.parse(req.rawBody || '{}'); } catch { return {}; }
}

const TARGET_MAP = {
  'AmazonEventBridge.PutRule':           putRule,
  'AmazonEventBridge.PutTargets':        putTargets,
  'AmazonEventBridge.PutEvents':         putEvents,
  'AmazonEventBridge.ListRules':         listRules,
  'AmazonEventBridge.DescribeRule':      describeRule,
  'AmazonEventBridge.DeleteRule':        deleteRule,
  'AmazonEventBridge.EnableRule':        enableRule,
  'AmazonEventBridge.DisableRule':       disableRule,
  'AmazonEventBridge.RemoveTargets':     removeTargets,
  'AmazonEventBridge.ListTargetsByRule': listTargetsByRule,
  'AmazonEventBridge.ListEventBuses':    listEventBuses,
  'AmazonEventBridge.DescribeEventBus':  describeEventBus,
  'AmazonEventBridge.CreateEventBus':    createEventBus,
  'AmazonEventBridge.DeleteEventBus':    (req, res) => jsonResponse(res, 200, {}),
  'AmazonEventBridge.TagResource':       (req, res) => jsonResponse(res, 200, {}),
  'AmazonEventBridge.ListTagsForResource': (req, res) => jsonResponse(res, 200, { Tags: [] }),
};

export function handler(req, res) {
  const target = req.headers['x-amz-target'] || '';
  // AWS SDK v2 uses 'AWSEvents.PutRule', SDK v3 uses 'AmazonEventBridge.PutRule'.
  // Normalize either prefix to look up our handler map.
  const normalized = target.replace(/^AWSEvents\./, 'AmazonEventBridge.');
  const fn = TARGET_MAP[normalized];
  if (fn) return fn(req, res);
  return errorJson(res, 400, 'InvalidAction', `Unknown EventBridge action: ${target}`);
}

function putRule(req, res) {
  const b = parseBody(req);
  if (!b.Name) return errorJson(res, 400, 'ValidationException', 'Name required');
  const bus = b.EventBusName || 'default';
  if (!store.eventbridge.buses[bus]) store.eventbridge.buses[bus] = { name: bus, rules: {} };
  store.eventbridge.buses[bus].rules[b.Name] = {
    Name:               b.Name,
    Arn:                arn('events', `rule/${bus}/${b.Name}`),
    EventBusName:       bus,
    ScheduleExpression: b.ScheduleExpression || null,
    EventPattern:       b.EventPattern ? (typeof b.EventPattern === 'string' ? b.EventPattern : JSON.stringify(b.EventPattern)) : null,
    State:              b.State || 'ENABLED',
    Description:        b.Description || '',
    targets:            store.eventbridge.buses[bus]?.rules[b.Name]?.targets || [],
    created:            Date.now(),
  };
  store.addTrail({ method: 'POST', path: `/events/rule/${b.Name}`, status: 200, latency: 3 });
  jsonResponse(res, 200, { RuleArn: arn('events', `rule/${bus}/${b.Name}`) });
}

function putTargets(req, res) {
  const b = parseBody(req);
  const bus = b.EventBusName || 'default';
  const rule = store.eventbridge.buses[bus]?.rules[b.Rule];
  if (!rule) return errorJson(res, 400, 'ResourceNotFoundException', `Rule ${b.Rule} not found`);
  rule.targets = rule.targets || [];
  for (const t of (b.Targets || [])) {
    const idx = rule.targets.findIndex(x => x.Id === t.Id);
    if (idx >= 0) rule.targets[idx] = t; else rule.targets.push(t);
  }
  jsonResponse(res, 200, { FailedEntryCount: 0, FailedEntries: [] });
}

async function putEvents(req, res) {
  const b = parseBody(req);
  const entries = b.Entries || [];
  const results = [];

  for (const entry of entries) {
    const eventId = randomId(36);
    results.push({ EventId: eventId });
    store.eventbridge.events.unshift({
      id:           eventId,
      source:       entry.Source,
      detailType:   entry['detail-type'] || entry.DetailType,
      detail:       entry.Detail,
      bus:          entry.EventBusName || 'default',
      time:         Date.now(),
    });
    if (store.eventbridge.events.length > 1000) store.eventbridge.events.pop();

    // Fire matching rules
    fireMatchingRules(entry).catch(() => {});
  }

  store.addTrail({ method: 'POST', path: '/events/PutEvents', status: 200, latency: 5 });
  jsonResponse(res, 200, { FailedEntryCount: 0, Entries: results });
}

async function fireMatchingRules(entry) {
  const bus = entry.EventBusName || 'default';
  const busData = store.eventbridge.buses[bus];
  if (!busData) return;

  // EventBridge wraps the user's Detail in this envelope when delivering to
  // targets. Most consumers (Lambda especially) parse this shape.
  const eventEnvelope = {
    version:      '0',
    id:           randomId(36),
    'detail-type': entry['detail-type'] || entry.DetailType,
    source:       entry.Source,
    account:      '000000000000',
    time:         new Date().toISOString(),
    region:       'us-east-1',
    resources:    entry.Resources || [],
    detail:       safeParseDetail(entry.Detail),
  };

  for (const rule of Object.values(busData.rules)) {
    if (rule.State !== 'ENABLED') continue;
    if (!matchesPattern(rule.EventPattern, entry)) continue;
    await deliverToTargets(rule, eventEnvelope);
  }
}

// Deliver an envelope to every target of a rule. Shared by event-matched
// delivery (PutEvents) and schedule-driven delivery (fireDueSchedulesOnce).
async function deliverToTargets(rule, envelope) {
  // Lazy imports to avoid module-load circular dependencies.
  const [{ invokeLambda }, { enqueueMessage, queueUrlForArn }] = await Promise.all([
    import('./lambda.js'),
    import('./sqs.js'),
  ]);
  for (const target of (rule.targets || [])) {
    try {
      if (target.Arn?.includes(':lambda:') || target.Arn?.includes(':function:')) {
        invokeLambda(target.Arn.split(':').pop(), envelope, { source: 'eventbridge' }).catch(() => {});
        continue;
      }
      if (target.Arn?.includes(':sqs:')) {
        const url = queueUrlForArn(target.Arn);
        if (url && store.sqs.queues[url]) enqueueMessage(url, JSON.stringify(envelope));
        continue;
      }
      if (target.Arn?.includes(':sns:')) {
        const topic = store.sns.topics[target.Arn];
        if (topic) {
          topic.published = (topic.published || 0) + 1;
          const { fanoutSnsMessage } = await import('./sns.js').catch(() => ({}));
          if (fanoutSnsMessage) {
            fanoutSnsMessage(topic, { msgId: randomId(36), message: JSON.stringify(envelope), subject: envelope['detail-type'] || '' }).catch(() => {});
          }
        }
        continue;
      }
    } catch (e) {
      console.warn(`[EventBridge] Target delivery failed (${target.Arn}):`, e.message);
    }
  }
}

// ── Scheduled rules (rate/cron) ────────────────────────────────────────────
// rate(N unit) is exact; cron(...) is approximated to a ~1-minute cadence (full
// cron-field parsing isn't implemented). Registered as a background tick;
// fireDueSchedulesOnce(now) is exported so tests can drive it deterministically.
function parseSchedule(expr) {
  const m = /^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/.exec(expr || '');
  if (m) {
    const ms = m[2].startsWith('minute') ? 60_000 : m[2].startsWith('hour') ? 3_600_000 : 86_400_000;
    return Number(m[1]) * ms;
  }
  if (/^cron\(/.test(expr || '')) return 60_000;
  return 0;
}

export async function fireDueSchedulesOnce(now = Date.now()) {
  for (const bus of Object.values(store.eventbridge.buses || {})) {
    for (const rule of Object.values(bus.rules || {})) {
      if (rule.State !== 'ENABLED' || !rule.ScheduleExpression) continue;
      const intervalMs = parseSchedule(rule.ScheduleExpression);
      if (!intervalMs) continue;
      if (rule._nextFireAt == null) rule._nextFireAt = (rule.created || now) + intervalMs;
      if (now < rule._nextFireAt) continue;
      rule._nextFireAt = now + intervalMs;
      rule._lastFiredAt = now;
      await deliverToTargets(rule, {
        version: '0', id: randomId(36), 'detail-type': 'Scheduled Event',
        source: 'aws.events', account: '000000000000', time: new Date(now).toISOString(),
        region: 'us-east-1', resources: [rule.Arn], detail: {},
      });
    }
  }
}

registerTick(() => { fireDueSchedulesOnce().catch(() => {}); });

function safeParseDetail(d) {
  if (!d) return {};
  if (typeof d === 'object') return d;
  try { return JSON.parse(d); } catch { return d; }
}

function matchesPattern(patternStr, event) {
  if (!patternStr) return false;
  try {
    const pattern = typeof patternStr === 'string' ? JSON.parse(patternStr) : patternStr;
    if (pattern.source && !pattern.source.includes(event.Source)) return false;
    if (pattern['detail-type'] && !pattern['detail-type'].includes(event['detail-type'] || event.DetailType)) return false;
    return true;
  } catch { return false; }
}

function listRules(req, res) {
  const b = parseBody(req);
  const bus = b.EventBusName || 'default';
  const rules = Object.values(store.eventbridge.buses[bus]?.rules || {}).map(r => ({
    Name: r.Name, Arn: r.Arn, State: r.State,
    ScheduleExpression: r.ScheduleExpression, EventPattern: r.EventPattern,
    EventBusName: r.EventBusName, Description: r.Description,
  }));
  jsonResponse(res, 200, { Rules: rules });
}

function describeRule(req, res) {
  const b = parseBody(req);
  const bus = b.EventBusName || 'default';
  const rule = store.eventbridge.buses[bus]?.rules[b.Name];
  if (!rule) return errorJson(res, 400, 'ResourceNotFoundException', `Rule ${b.Name} not found`);
  jsonResponse(res, 200, rule);
}

function deleteRule(req, res) {
  const b = parseBody(req);
  const bus = b.EventBusName || 'default';
  if (store.eventbridge.buses[bus]?.rules) delete store.eventbridge.buses[bus].rules[b.Name];
  store.addTrail({ method: 'DELETE', path: `/events/rule/${b.Name}`, status: 200, latency: 2 });
  jsonResponse(res, 200, {});
}

function enableRule(req, res) {
  const b = parseBody(req);
  const bus = b.EventBusName || 'default';
  const rule = store.eventbridge.buses[bus]?.rules[b.Name];
  if (rule) rule.State = 'ENABLED';
  jsonResponse(res, 200, {});
}

function disableRule(req, res) {
  const b = parseBody(req);
  const bus = b.EventBusName || 'default';
  const rule = store.eventbridge.buses[bus]?.rules[b.Name];
  if (rule) rule.State = 'DISABLED';
  jsonResponse(res, 200, {});
}

function removeTargets(req, res) {
  const b = parseBody(req);
  const bus = b.EventBusName || 'default';
  const rule = store.eventbridge.buses[bus]?.rules[b.Rule];
  if (rule) rule.targets = (rule.targets || []).filter(t => !b.Ids?.includes(t.Id));
  jsonResponse(res, 200, { FailedEntryCount: 0, FailedEntries: [] });
}

function listTargetsByRule(req, res) {
  const b = parseBody(req);
  const bus = b.EventBusName || 'default';
  const rule = store.eventbridge.buses[bus]?.rules[b.Rule];
  jsonResponse(res, 200, { Targets: rule?.targets || [] });
}

function listEventBuses(req, res) {
  const buses = Object.values(store.eventbridge.buses).map(b => ({
    Name: b.name, Arn: arn('events', `event-bus/${b.name}`),
  }));
  if (!buses.find(b => b.Name === 'default')) {
    buses.unshift({ Name: 'default', Arn: arn('events', 'event-bus/default') });
  }
  jsonResponse(res, 200, { EventBuses: buses });
}

function describeEventBus(req, res) {
  const b = parseBody(req);
  const name = b.Name || 'default';
  jsonResponse(res, 200, { Name: name, Arn: arn('events', `event-bus/${name}`) });
}

function createEventBus(req, res) {
  const b = parseBody(req);
  if (!b.Name) return errorJson(res, 400, 'ValidationException', 'Name required');
  store.eventbridge.buses[b.Name] = { name: b.Name, rules: {} };
  jsonResponse(res, 200, { EventBusArn: arn('events', `event-bus/${b.Name}`) });
}
