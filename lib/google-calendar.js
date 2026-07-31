const { google } = require('googleapis');
const {
  dayKeyToIsoDate,
  eventsKeyDayPrefix,
  nextIsoDate,
  multiDayKeysToGoogleAllDayBounds,
} = require('./day-key');

const TIME_ZONE = 'America/New_York';
const SYNCED_IDS_KEY = '__google_synced_ids__';
const MULTIDAY_KEY = '__multiday__';

function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  try {
    return JSON.parse(raw);
  } catch (_) {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch (err) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON or base64 JSON');
    }
  }
}

function getCalendarClient() {
  const credentials = loadServiceAccount();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

function calendarId() {
  const id = process.env.GOOGLE_CALENDAR_ID;
  if (!id) throw new Error('Missing GOOGLE_CALENDAR_ID');
  return id;
}

function isGoogleConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_CALENDAR_ID);
}

function parseTimeParts(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Multi-day all-day span stored with inclusive startDayKey / endDayKey. */
function isMultidayEvent(ev) {
  return Boolean(ev && ev.startDayKey && ev.endDayKey);
}

/** True when Field Planner has no parseable start time → Google all-day event. */
function isAllDayEvent(ev) {
  if (isMultidayEvent(ev)) return true;
  return !parseTimeParts(ev && ev.startTime);
}

/**
 * Google all-day bounds: bare YYYY-MM-DD only (no dateTime, no timeZone).
 * end.date is exclusive — one day on Aug 2 → start 2026-08-02, end 2026-08-03.
 */
function toAllDayGoogleBounds(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))) {
    throw new Error(`Invalid ISO date for all-day event: ${isoDate}`);
  }
  return {
    start: { date: isoDate },
    end: { date: nextIsoDate(isoDate) },
  };
}

function formatDateTime(isoDate, hour, minute) {
  return `${isoDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function addOneHour(hour, minute) {
  let h = hour + 1;
  let m = minute;
  if (h >= 24) {
    h = 23;
    m = 59;
  }
  return { hour: h, minute: m };
}

function eventSummary(ev) {
  return String(ev.title || ev.business || '(untitled)').trim() || '(untitled)';
}

function eventDescription(ev) {
  const lines = [];
  if (ev.business && ev.title) lines.push(`Company: ${ev.business}`);
  if (ev.contact) lines.push(`Contact: ${ev.contact}`);
  if (ev.email) lines.push(`Email: ${ev.email}`);
  return lines.join('\n') || undefined;
}

function eventLocation(ev) {
  const loc = String(ev.location || '').trim();
  return loc || undefined;
}

function isRateLimitError(err) {
  const status = err?.code || err?.response?.status;
  const msg = String(err?.message || '');
  return status === 403 || status === 429 || /rate limit/i.test(msg);
}

/** Build a Google Calendar event resource from a Field Planner day event. */
function toGoogleEventBody(ev, isoDate) {
  const body = {
    summary: eventSummary(ev),
    description: eventDescription(ev),
    location: eventLocation(ev),
    extendedProperties: {
      private: {
        fpApp: 'field-planner',
        fpLocalId: String(ev.id),
      },
    },
  };

  // Multi-day all-day: convert BOTH day keys (0-based months) → exclusive Google end.
  if (isMultidayEvent(ev)) {
    const bounds = multiDayKeysToGoogleAllDayBounds(ev.startDayKey, ev.endDayKey);
    body.start = bounds.start;
    body.end = bounds.end;
    return body;
  }

  // Single-day all-day: bare date only. Never dateTime (UTC midnight shifts a day earlier in ET).
  if (isAllDayEvent(ev)) {
    const bounds = toAllDayGoogleBounds(isoDate);
    body.start = bounds.start;
    body.end = bounds.end;
    return body;
  }

  const startParts = parseTimeParts(ev.startTime);
  const endParts = parseTimeParts(ev.endTime);
  const end = endParts || addOneHour(startParts.hour, startParts.minute);
  let endHour = end.hour;
  let endMinute = end.minute;
  if (
    endHour < startParts.hour ||
    (endHour === startParts.hour && endMinute <= startParts.minute)
  ) {
    const bumped = addOneHour(startParts.hour, startParts.minute);
    endHour = bumped.hour;
    endMinute = bumped.minute;
  }
  body.start = {
    dateTime: formatDateTime(isoDate, startParts.hour, startParts.minute),
    timeZone: TIME_ZONE,
  };
  body.end = {
    dateTime: formatDateTime(isoDate, endHour, endMinute),
    timeZone: TIME_ZONE,
  };

  return body;
}

function parseJsonArray(raw) {
  if (raw == null || raw === '') return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function isSyncableEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (!ev.id) return false;
  if (isMultidayEvent(ev)) return Boolean(ev.title || ev.business);
  return Boolean(ev.title || ev.business || ev.startTime || ev.endTime);
}

/** Parse __multiday__ array; returns mutable event objects. */
function collectMultidayEvents(payload) {
  return parseJsonArray(payload[MULTIDAY_KEY]).filter(isSyncableEvent);
}

/**
 * Collect non-recurring day events from the household payload.
 * Returns [{ key, dayKey, isoDate, allEvents, syncable }] with mutable event objects.
 */
function collectDayEvents(payload) {
  const out = [];
  for (const key of Object.keys(payload || {})) {
    const dayKey = eventsKeyDayPrefix(key);
    if (!dayKey) continue;
    let isoDate;
    try {
      isoDate = dayKeyToIsoDate(dayKey);
    } catch (err) {
      console.warn('[google-calendar] Skipping bad day key:', dayKey, err.message);
      continue;
    }
    const allEvents = parseJsonArray(payload[key]);
    const syncable = allEvents.filter(isSyncableEvent);
    out.push({ key, dayKey, isoDate, allEvents, syncable });
  }
  return out;
}

function readSyncedIds(payload) {
  return new Set(parseJsonArray(payload[SYNCED_IDS_KEY]).filter(Boolean).map(String));
}

async function deleteGoogleEvent(calendar, calId, eventId) {
  try {
    await calendar.events.delete({ calendarId: calId, eventId });
    return { ok: true };
  } catch (err) {
    const status = err?.code || err?.response?.status;
    if (status === 404 || status === 410) return { ok: true, missing: true };
    throw err;
  }
}

/** List Field Planner–tagged events on the dedicated calendar. */
async function listTaggedCalendarEvents(calendar, calId) {
  const items = [];
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId: calId,
      privateExtendedProperty: ['fpApp=field-planner'],
      singleEvents: false,
      showDeleted: false,
      maxResults: 250,
      pageToken,
    });
    if (Array.isArray(res.data.items)) items.push(...res.data.items);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

function assertValidGoogleTimeBody(body) {
  const start = body.start || {};
  const end = body.end || {};
  const startIsDate = Boolean(start.date) && !start.dateTime;
  const startIsDateTime = Boolean(start.dateTime) && !start.date;
  if (!startIsDate && !startIsDateTime) {
    throw new Error('Google event start must be either date or dateTime, not both/neither');
  }
  if (startIsDate) {
    if (start.timeZone || end.timeZone || start.dateTime || end.dateTime) {
      throw new Error('All-day Google events must not include dateTime or timeZone');
    }
    if (!end.date || end.dateTime) {
      throw new Error('All-day Google events require exclusive end.date only');
    }
  }
}

async function upsertGoogleEvent(calendar, calId, ev, isoDate, byLocalId) {
  const body = toGoogleEventBody(ev, isoDate);
  assertValidGoogleTimeBody(body);
  const localId = String(ev.id);
  const candidates = [...(byLocalId.get(localId) || [])];
  const preferredId = ev.googleEventId ? String(ev.googleEventId) : '';

  const tryUpdate = async (eventId) => {
    const updated = await calendar.events.update({
      calendarId: calId,
      eventId,
      requestBody: body,
    });
    return updated.data.id;
  };

  if (preferredId) {
    try {
      const id = await tryUpdate(preferredId);
      return { googleEventId: id, action: 'updated' };
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      const status = err?.code || err?.response?.status;
      if (status !== 404 && status !== 410) throw err;
    }
  }

  for (const g of candidates) {
    if (preferredId && g.id === preferredId) continue;
    try {
      const id = await tryUpdate(g.id);
      return { googleEventId: id, action: 'updated' };
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      const status = err?.code || err?.response?.status;
      if (status !== 404 && status !== 410) throw err;
    }
  }

  const created = await calendar.events.insert({
    calendarId: calId,
    requestBody: body,
  });
  return {
    googleEventId: created.data.id,
    action: preferredId ? 'recreated' : 'created',
  };
}

async function applyUpsertResult(stats, livingGoogleIds, ev, result, syncedAt) {
  ev.googleEventId = result.googleEventId;
  ev.googleSyncedAt = syncedAt;
  livingGoogleIds.add(String(result.googleEventId));
  if (result.action === 'created') stats.created += 1;
  else if (result.action === 'updated') stats.updated += 1;
  else stats.recreated += 1;
}

/**
 * Push non-recurring day events + __multiday__ spans to Google Calendar.
 * Mutates payload in place: googleEventId / googleSyncedAt on events, plus SYNCED_IDS_KEY.
 *
 * opts.keys: optional list of `{dayKey}-events` and/or `__multiday__` that changed.
 * Orphan deletes still consider the full local event set.
 */
async function syncPayloadToGoogle(payload, opts = {}) {
  const calendar = getCalendarClient();
  const calId = calendarId();
  const dayGroups = collectDayEvents(payload);
  const multidayEvents = collectMultidayEvents(payload);
  const stats = { created: 0, updated: 0, deleted: 0, recreated: 0, errors: [], rateLimited: false };
  const syncedAt = new Date().toISOString();

  const rawKeys = Array.isArray(opts.keys) ? opts.keys.filter(k => typeof k === 'string') : [];
  const focusKeys = rawKeys.length
    ? new Set(rawKeys.filter(k => k.endsWith('-events') || k === MULTIDAY_KEY))
    : null;
  const focusMultiday = Boolean(focusKeys && focusKeys.has(MULTIDAY_KEY));

  const localIds = new Set();
  for (const group of dayGroups) {
    for (const ev of group.syncable) localIds.add(String(ev.id));
  }
  for (const ev of multidayEvents) localIds.add(String(ev.id));

  let googleItems = [];
  try {
    googleItems = await listTaggedCalendarEvents(calendar, calId);
  } catch (err) {
    if (isRateLimitError(err)) {
      stats.rateLimited = true;
      stats.errors.push({ op: 'list', error: err.message });
      return stats;
    }
    throw err;
  }

  const byLocalId = new Map();
  for (const g of googleItems) {
    const localId = g.extendedProperties?.private?.fpLocalId;
    if (!localId) continue;
    if (!byLocalId.has(localId)) byLocalId.set(localId, []);
    byLocalId.get(localId).push(g);
  }

  // Remove Google events whose local event no longer exists.
  for (const [localId, items] of byLocalId) {
    if (localIds.has(localId)) continue;
    for (const g of items) {
      try {
        await deleteGoogleEvent(calendar, calId, g.id);
        stats.deleted += 1;
      } catch (err) {
        if (isRateLimitError(err)) {
          stats.rateLimited = true;
          stats.errors.push({ googleEventId: g.id, op: 'delete', error: err.message });
          break;
        }
        console.error('[google-calendar] orphan delete failed', g.id, err.message);
        stats.errors.push({ googleEventId: g.id, op: 'delete', error: err.message });
      }
    }
    if (stats.rateLimited) break;
  }

  // Also drop registry ids that are no longer on any local event.
  const livingGoogleIds = new Set();
  for (const group of dayGroups) {
    for (const ev of group.syncable) {
      if (ev.googleEventId) livingGoogleIds.add(String(ev.googleEventId));
    }
  }
  for (const ev of multidayEvents) {
    if (ev.googleEventId) livingGoogleIds.add(String(ev.googleEventId));
  }
  for (const id of readSyncedIds(payload)) {
    if (livingGoogleIds.has(id) || stats.rateLimited) continue;
    try {
      await deleteGoogleEvent(calendar, calId, id);
      stats.deleted += 1;
    } catch (err) {
      if (isRateLimitError(err)) {
        stats.rateLimited = true;
        stats.errors.push({ googleEventId: id, op: 'delete', error: err.message });
        break;
      }
      const status = err?.code || err?.response?.status;
      if (status !== 404 && status !== 410) {
        console.error('[google-calendar] registry delete failed', id, err.message);
        stats.errors.push({ googleEventId: id, op: 'delete', error: err.message });
      }
    }
  }

  // Upsert only touched days (or, if no keys given, only events never pushed before).
  const groupsToUpsert = focusKeys
    ? dayGroups.filter(g => focusKeys.has(g.key))
    : dayGroups.filter(g => g.syncable.some(ev => !ev.googleEventId));

  for (const group of groupsToUpsert) {
    if (stats.rateLimited) break;
    for (const ev of group.syncable) {
      try {
        const result = await upsertGoogleEvent(calendar, calId, ev, group.isoDate, byLocalId);
        applyUpsertResult(stats, livingGoogleIds, ev, result, syncedAt);
      } catch (err) {
        if (isRateLimitError(err)) {
          stats.rateLimited = true;
          stats.errors.push({ localEventId: ev.id, op: 'upsert', error: err.message });
          break;
        }
        console.error('[google-calendar] upsert failed', ev.id, err.message);
        stats.errors.push({ localEventId: ev.id, op: 'upsert', error: err.message });
      }
    }
    payload[group.key] = JSON.stringify(group.allEvents);
  }

  // Multi-day spans (one Google event each).
  const multidayToUpsert = focusMultiday
    ? multidayEvents
    : (!focusKeys ? multidayEvents.filter(ev => !ev.googleEventId) : []);

  if (multidayToUpsert.length && !stats.rateLimited) {
    // Keep full array (including non-syncable stubs) when writing back.
    const allMultiday = parseJsonArray(payload[MULTIDAY_KEY]);
    const byId = new Map(allMultiday.filter(e => e && e.id).map(e => [String(e.id), e]));

    for (const ev of multidayToUpsert) {
      if (stats.rateLimited) break;
      try {
        // isoDate unused for multiday — toGoogleEventBody reads startDayKey/endDayKey.
        const result = await upsertGoogleEvent(calendar, calId, ev, null, byLocalId);
        applyUpsertResult(stats, livingGoogleIds, ev, result, syncedAt);
        const stored = byId.get(String(ev.id));
        if (stored) {
          stored.googleEventId = ev.googleEventId;
          stored.googleSyncedAt = ev.googleSyncedAt;
        }
      } catch (err) {
        if (isRateLimitError(err)) {
          stats.rateLimited = true;
          stats.errors.push({ localEventId: ev.id, op: 'upsert', error: err.message });
          break;
        }
        console.error('[google-calendar] multiday upsert failed', ev.id, err.message);
        stats.errors.push({ localEventId: ev.id, op: 'upsert', error: err.message });
      }
    }
    payload[MULTIDAY_KEY] = JSON.stringify(allMultiday);
  }

  // Refresh registry from whatever local events currently know about.
  const nextSynced = new Set();
  for (const group of dayGroups) {
    for (const ev of group.syncable) {
      if (ev.googleEventId) nextSynced.add(String(ev.googleEventId));
    }
  }
  for (const ev of collectMultidayEvents(payload)) {
    if (ev.googleEventId) nextSynced.add(String(ev.googleEventId));
  }
  payload[SYNCED_IDS_KEY] = JSON.stringify([...nextSynced]);
  return stats;
}

module.exports = {
  TIME_ZONE,
  SYNCED_IDS_KEY,
  MULTIDAY_KEY,
  isGoogleConfigured,
  dayKeyToIsoDate,
  multiDayKeysToGoogleAllDayBounds,
  isMultidayEvent,
  isAllDayEvent,
  toAllDayGoogleBounds,
  toGoogleEventBody,
  collectDayEvents,
  collectMultidayEvents,
  syncPayloadToGoogle,
};
