const { google } = require('googleapis');
const { dayKeyToIsoDate, eventsKeyDayPrefix } = require('./day-key');

const TIME_ZONE = 'America/New_York';
const SYNCED_IDS_KEY = '__google_synced_ids__';

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

function nextIsoDate(isoDate) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
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
  const startParts = parseTimeParts(ev.startTime);
  const endParts = parseTimeParts(ev.endTime);
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

  if (startParts) {
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
  } else {
    body.start = { date: isoDate };
    body.end = { date: nextIsoDate(isoDate) };
  }

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
  return Boolean(ev.title || ev.business || ev.startTime || ev.endTime);
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

async function upsertGoogleEvent(calendar, calId, ev, isoDate, byLocalId) {
  const body = toGoogleEventBody(ev, isoDate);
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

/**
 * Push non-recurring day events to Google Calendar.
 * Mutates payload in place: googleEventId / googleSyncedAt on events, plus SYNCED_IDS_KEY.
 *
 * opts.keys: optional list of `{dayKey}-events` keys that changed. When provided, only those
 * days are upserted (avoids rate-limiting by touching the whole calendar every save).
 * Orphan deletes still consider the full local event set.
 */
async function syncPayloadToGoogle(payload, opts = {}) {
  const calendar = getCalendarClient();
  const calId = calendarId();
  const dayGroups = collectDayEvents(payload);
  const stats = { created: 0, updated: 0, deleted: 0, recreated: 0, errors: [], rateLimited: false };
  const syncedAt = new Date().toISOString();

  const focusKeys = Array.isArray(opts.keys) && opts.keys.length
    ? new Set(opts.keys.filter(k => typeof k === 'string' && k.endsWith('-events')))
    : null;

  const localIds = new Set();
  for (const group of dayGroups) {
    for (const ev of group.syncable) localIds.add(String(ev.id));
  }

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
      // Already gone is fine; other errors are logged.
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
        ev.googleEventId = result.googleEventId;
        ev.googleSyncedAt = syncedAt;
        livingGoogleIds.add(String(result.googleEventId));
        if (result.action === 'created') stats.created += 1;
        else if (result.action === 'updated') stats.updated += 1;
        else stats.recreated += 1;
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

  // Refresh registry from whatever local events currently know about.
  const nextSynced = new Set();
  for (const group of dayGroups) {
    for (const ev of group.syncable) {
      if (ev.googleEventId) nextSynced.add(String(ev.googleEventId));
    }
  }
  payload[SYNCED_IDS_KEY] = JSON.stringify([...nextSynced]);
  return stats;
}

module.exports = {
  TIME_ZONE,
  SYNCED_IDS_KEY,
  isGoogleConfigured,
  dayKeyToIsoDate,
  toGoogleEventBody,
  collectDayEvents,
  syncPayloadToGoogle,
};
