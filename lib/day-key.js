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

module.exports = {
  dayKeyToIsoDate,
  eventsKeyDayPrefix,
};
