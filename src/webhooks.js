import {
  WEBHOOK_SECRET,
  SPORTFENGUR_LOCALE,
  DEDUPE_TTL_MS,
  getEventIdFilter,
  setEventIdFilter,
} from './config.js';
import { apiGetWithRetry } from './sportfengur.js';
import { scheduleRefresh, setCompetitionContext } from './vmix/refresh.js';
import { getCompetitionMetadata } from './vmix/state.js';
import { clearStartingListCache } from './vmix/vendor.js';
import { log } from './logger.js';
import { requireControlSession } from './control-auth.js';

const EVENT_DEFINITIONS = {
  event_einkunn_saeti: ['eventId', 'classId', 'competitionId'],
  event_mot_skra: ['eventId'],
  event_keppendalisti_breyta: ['eventId'],
  event_motadagskra_breytist: ['eventId'],
  event_raslisti_birtur: ['eventId', 'classId', 'published'],
  event_naesti_sprettur: ['eventId', 'classId', 'competitionId'],
  event_keppnisgreinar: ['eventId'],
};

const dedupeCache = new Map();
const competitionIdByClassId = new Map();
let lastWebhookAt = null;
let lastWebhookProcessedAt = null;
let lastError = null;
let currentPayload = null;
const webhookHistory = [];
const WEBHOOK_HISTORY_LIMIT = 200;

function pushWebhookHistory(entry) {
  webhookHistory.unshift({
    at: new Date().toISOString(),
    ...entry,
  });
  if (webhookHistory.length > WEBHOOK_HISTORY_LIMIT) {
    webhookHistory.length = WEBHOOK_HISTORY_LIMIT;
  }
}

function requireWebhookSecret(req, res, eventName) {
  const secretHeader = req.header('x-webhook-secret') || '';
  if (!WEBHOOK_SECRET || secretHeader !== WEBHOOK_SECRET) {
    log.webhook.unauthorized(eventName, Boolean(secretHeader));
    pushWebhookHistory({
      status: 'unauthorized',
      eventName,
      hasSecretHeader: Boolean(secretHeader),
    });
    res.status(401).send('Unauthorized');
    return false;
  }
  return true;
}

function validatePayload(eventName, payload) {
  const required = EVENT_DEFINITIONS[eventName] || [];
  const missing = required.filter(
    (key) =>
      payload[key] === undefined ||
      payload[key] === null ||
      payload[key] === '',
  );
  return missing;
}

function normalizePayload(payload) {
  return {
    ...payload,
    eventId: payload.eventId ?? payload.eventid ?? payload.event_id,
    classId: payload.classId ?? payload.classid ?? payload.class_id,
    competitionId:
      payload.competitionId ?? payload.competitionid ?? payload.competition_id,
    published:
      payload.published ?? payload.published_at ?? payload.is_published,
  };
}

function pruneDedupeCache() {
  const now = Date.now();
  for (const [key, ts] of dedupeCache.entries()) {
    if (now - ts > DEDUPE_TTL_MS) {
      dedupeCache.delete(key);
    }
  }
}

function dedupeKey(eventName, payload) {
  return [
    eventName,
    payload.eventId ?? '',
    payload.classId ?? '',
    payload.competitionId ?? '',
    payload.published ?? '',
  ].join('|');
}

function isAllowedEventId(payload) {
  const eventIdFilter = getEventIdFilter();
  if (eventIdFilter == null) {
    return true;
  }
  return Number(payload.eventId) === eventIdFilter;
}

function isAllowedClassId(payload) {
  const { classId: currentClassId } = getCompetitionMetadata();
  // Fresh startup — no class selected yet, allow all webhooks through
  if (currentClassId == null) {
    return true;
  }
  // Event has no classId in payload (e.g., event_keppendalisti_breyta) — allow through
  if (payload.classId == null) {
    return true;
  }
  // Only allow if classId matches the currently active class
  return Number(payload.classId) === Number(currentClassId);
}

async function resolveCompetitionId(payload) {
  if (payload.competitionId != null) {
    competitionIdByClassId.set(payload.classId, payload.competitionId);
    return payload.competitionId;
  }
  if (payload.classId != null && competitionIdByClassId.has(payload.classId)) {
    return competitionIdByClassId.get(payload.classId);
  }
  if (payload.eventId == null || payload.classId == null) {
    return null;
  }
  const data = await apiGetWithRetry(
    `/${SPORTFENGUR_LOCALE}/event/tests/${payload.eventId}`,
  );
  const tests = Array.isArray(data?.res) ? data.res : [];
  const match = tests.find(
    (item) => Number(item.flokkar_numer) === Number(payload.classId),
  );
  if (match?.keppni_numer != null) {
    competitionIdByClassId.set(payload.classId, match.keppni_numer);
    return match.keppni_numer;
  }
  return null;
}

async function handleWebhook(req, res, eventName) {
  if (!requireWebhookSecret(req, res, eventName)) {
    return;
  }

  const payload = normalizePayload(req.body || {});
  const missing = validatePayload(eventName, payload);
  if (missing.length > 0) {
    log.webhook.invalidPayload(eventName, missing);
    pushWebhookHistory({
      status: 'invalid_payload',
      eventName,
      missing,
      eventId: payload.eventId ?? null,
      classId: payload.classId ?? null,
      competitionId: payload.competitionId ?? null,
    });
    res.status(400).send(`Missing required fields: ${missing.join(', ')}`);
    return;
  }

  log.webhook.received(eventName, payload);
  res.send('Skeyti móttekið');

  lastWebhookAt = new Date().toISOString();
  const key = dedupeKey(eventName, payload);
  pruneDedupeCache();
  if (dedupeCache.has(key)) {
    log.webhook.duplicate(key);
    pushWebhookHistory({
      status: 'duplicate',
      eventName,
      key,
      eventId: payload.eventId ?? null,
      classId: payload.classId ?? null,
      competitionId: payload.competitionId ?? null,
    });
    return;
  }
  dedupeCache.set(key, Date.now());

  try {
    const start = Date.now();
    log.webhook.processing(eventName);

    if (!isAllowedEventId(payload)) {
      log.webhook.filtered(payload.eventId ?? 'N/A', getEventIdFilter());
      pushWebhookHistory({
        status: 'filtered',
        eventName,
        eventId: payload.eventId ?? null,
        classId: payload.classId ?? null,
        competitionId: payload.competitionId ?? null,
      });
      return;
    }

    if (!isAllowedClassId(payload)) {
      const { classId: currentClassId } = getCompetitionMetadata();
      log.webhook.filtered(payload.classId ?? 'N/A', currentClassId);
      pushWebhookHistory({
        status: 'classId_filtered',
        eventName,
        eventId: payload.eventId ?? null,
        classId: payload.classId ?? null,
        competitionId: payload.competitionId ?? null,
        currentClassId: currentClassId ?? null,
      });
      return;
    }

    let resolvedCompetitionId = payload.competitionId;

    if (!resolvedCompetitionId && payload.classId) {
      resolvedCompetitionId = await resolveCompetitionId(payload);
    }

    if (payload.eventId && payload.classId && resolvedCompetitionId) {
      const forceRefresh =
        eventName === 'event_raslisti_birtur' ||
        eventName === 'event_naesti_sprettur';

      setCompetitionContext(
        payload.eventId,
        payload.classId,
        resolvedCompetitionId,
        forceRefresh,
      );
      try {
        scheduleRefresh();
        log.vmix.scheduled(
          payload.eventId,
          payload.classId,
          resolvedCompetitionId,
          forceRefresh,
        );
      } catch (error) {
        log.error('vMix refresh scheduling', error);
      }
    } else {
      log.vmix.noContext();
    }

    lastWebhookProcessedAt = new Date().toISOString();
    log.webhook.completed(eventName, Date.now() - start);
    pushWebhookHistory({
      status: 'processed',
      eventName,
      eventId: payload.eventId ?? null,
      classId: payload.classId ?? null,
      competitionId: payload.competitionId ?? null,
      durationMs: Date.now() - start,
    });
  } catch (error) {
    lastError = `${new Date().toISOString()} ${eventName} ${error.message}`;
    log.error(`webhook ${eventName}`, error);
    pushWebhookHistory({
      status: 'error',
      eventName,
      eventId: payload.eventId ?? null,
      classId: payload.classId ?? null,
      competitionId: payload.competitionId ?? null,
      message: error.message,
    });
  }
}

export function registerWebhookRoutes(app) {
  Object.keys(EVENT_DEFINITIONS).forEach((eventName) => {
    app.post(`/${eventName}`, (req, res) => {
      handleWebhook(req, res, eventName).catch((error) => {
        console.error(`Webhook ${eventName} failed:`, error);
        res.status(500).send('Internal Server Error');
      });
    });
  });
}

export function registerHealthRoute(app) {
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      lastWebhookAt,
      lastWebhookProcessedAt,
      lastError,
    });
  });
}

export function registerTestRoute(app) {
  app.post('/webhooks/test', (req, res) => {
    log.webhook.received('test', req.body);
    res.send('Skeyti móttekið');
  });
}

export function registerCurrentRoutes(app) {
  app.get('/current', (req, res) => {
    res.json(currentPayload ?? {});
  });

  app.post('/current', (req, res) => {
    currentPayload = req.body || {};
    res.send('Skeyti móttekið');
  });
}

export function registerCacheRoutes(app) {
  app.post('/cache/raslisti/clear', (req, res) => {
    clearStartingListCache();
    res.send('Cache hreinsað');
  });
}

export function registerConfigRoutes(app) {
  app.get('/config/event-filter', (req, res) => {
    if (!requireControlSession(req, res, true)) return;
    res.json({ eventIdFilter: getEventIdFilter() });
  });

  app.post('/config/event-filter', (req, res) => {
    if (!requireControlSession(req, res, true)) return;
    const value =
      req.body?.eventIdFilter === undefined
        ? req.body?.eventId
        : req.body?.eventIdFilter;

    if (value === undefined) {
      return res.status(400).json({
        error: 'Missing eventIdFilter (or eventId) in request body',
      });
    }

    try {
      if (value === null || value === '') {
        setEventIdFilter(null);
      } else {
        setEventIdFilter(value);
      }
      return res.json({ eventIdFilter: getEventIdFilter() });
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid eventIdFilter',
        message: error.message,
      });
    }
  });
}

export function registerControlWebhookRoutes(app) {
  app.get('/control/webhooks', (req, res) => {
    if (!requireControlSession(req, res, true)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json({
      total: webhookHistory.length,
      items: webhookHistory,
    });
  });
}

export function registerRootRoute(app) {
  app.get('/', (req, res) => {
    res.redirect('/docs');
  });
}
