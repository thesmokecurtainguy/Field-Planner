/**
 * Field Planner day keys use JS Date 0-based months.
 * Example: July 31, 2026 → "2026-06-31" (month 6 = July)
 *
 * Accepts bare keys ("2026-06-31") or events keys ("2026-06-31-events").
 * Returns a real ISO calendar date: "YYYY-MM-DD" with 1-based month.
 */
function dayKeyToIsoDate(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:-events)?$/.exec(String(dayKey || '').trim());
  if (!m) {
    throw new Error(`Invalid Field Planner day key: ${dayKey}`);
  }
  const year = Number(m[1]);
  const jsMonth = Number(m[2]); // 0-based
  const day = Number(m[3]);

  if (!Number.isInteger(jsMonth) || jsMonth < 0 || jsMonth > 11) {
    throw new Error(`Invalid 0-based month in day key: ${dayKey}`);
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`Invalid day in day key: ${dayKey}`);
  }

  const isoMonth = jsMonth + 1;
  const iso = `${year}-${String(isoMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  const probe = new Date(year, jsMonth, day);
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() !== jsMonth ||
    probe.getDate() !== day
  ) {
    throw new Error(`Impossible calendar date in day key: ${dayKey} → ${iso}`);
  }

  return iso;
}

/** Extract the day-key prefix from an events payload key, or null if not an events key. */
function eventsKeyDayPrefix(key) {
  const m = /^(\d{4}-\d{2}-\d{2})-events$/.exec(String(key || ''));
  return m ? m[1] : null;
}

function nextIsoDate(isoDate) {
  const [y, mo, d] = String(isoDate).split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function prevIsoDate(isoDate) {
  const [y, mo, d] = String(isoDate).split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * Real ISO calendar date (1-based month) → Field Planner day key (0-based month).
 * Example: "2026-07-31" → "2026-06-31"
 */
function isoDateToDayKey(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || '').trim());
  if (!m) {
    throw new Error(`Invalid ISO date: ${isoDate}`);
  }
  const year = Number(m[1]);
  const isoMonth = Number(m[2]); // 1-based
  const day = Number(m[3]);
  if (!Number.isInteger(isoMonth) || isoMonth < 1 || isoMonth > 12) {
    throw new Error(`Invalid month in ISO date: ${isoDate}`);
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`Invalid day in ISO date: ${isoDate}`);
  }
  const jsMonth = isoMonth - 1;
  const probe = new Date(year, jsMonth, day);
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() !== jsMonth ||
    probe.getDate() !== day
  ) {
    throw new Error(`Impossible calendar date in ISO date: ${isoDate}`);
  }
  return `${year}-${String(jsMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Convert inclusive Field Planner day-key range → Google all-day start/end.
 * BOTH keys go through dayKeyToIsoDate (0-based month → real ISO date).
 * Google end.date is exclusive: last day Aug 14 → end 2026-08-15.
 */
function multiDayKeysToGoogleAllDayBounds(startDayKey, endDayKey) {
  const startIso = dayKeyToIsoDate(startDayKey);
  const endIsoInclusive = dayKeyToIsoDate(endDayKey);
  if (startIso > endIsoInclusive) {
    throw new Error(
      `Multi-day range start after end: ${startDayKey} (${startIso}) > ${endDayKey} (${endIsoInclusive})`
    );
  }
  return {
    start: { date: startIso },
    end: { date: nextIsoDate(endIsoInclusive) },
  };
}

module.exports = {
  dayKeyToIsoDate,
  isoDateToDayKey,
  eventsKeyDayPrefix,
  nextIsoDate,
  prevIsoDate,
  multiDayKeysToGoogleAllDayBounds,
};
