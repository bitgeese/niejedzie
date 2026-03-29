/**
 * Time parsing and comparison utilities for Polish train delay tracking.
 *
 * Database stores times in ISO format ("2026-03-28T14:30:00") via the scraper's
 * The scraper stores times as HH:MM. These functions handle comparison.
 */

/**
 * Normalizes time strings from any supported format to "HH:MM".
 * Handles: "HH:MM", "HH:MM:SS", ISO "YYYY-MM-DDTHH:MM:SS"
 */
export function formatTime(value: string | null): string | null {
  if (!value) return null;
  // Already HH:MM
  if (/^\d{2}:\d{2}$/.test(value)) return value;
  // HH:MM:SS → HH:MM
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) return value.slice(0, 5);
  // ISO datetime — extract time portion
  if (value.includes('T')) {
    const timePart = value.split('T')[1];
    return timePart ? timePart.slice(0, 5) : null;
  }
  return value;
}

/**
 * Returns current Poland time components.
 * Extracted for testability — tests can mock this.
 */
export function getPolandTime(now?: Date): { hours: number; minutes: number; dateStr: string } {
  const date = now ?? new Date();
  const polandTime = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  return {
    hours: polandTime.getHours(),
    minutes: polandTime.getMinutes(),
    dateStr: [
      polandTime.getFullYear(),
      String(polandTime.getMonth() + 1).padStart(2, '0'),
      String(polandTime.getDate()).padStart(2, '0'),
    ].join('-'),
  };
}

/**
 * Parses a normalized "HH:MM" string into total minutes since midnight.
 * Returns null if parsing fails.
 */
export function parseTimeToMinutes(timeStr: string): number | null {
  const [hourStr, minuteStr] = timeStr.split(':');
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

/**
 * Checks if a time value (in any supported format) is in the past
 * relative to current Poland time.
 */
export function isTimeInPast(
  rawTime: string | null,
  operatingDate: string,
  now?: Date,
): boolean {
  if (!rawTime) return false;

  const normalized = formatTime(rawTime);
  if (!normalized) return false;

  const minutes = parseTimeToMinutes(normalized);
  if (minutes === null) return false;

  const poland = getPolandTime(now);

  // Different date: past if operating date is before today
  if (operatingDate !== poland.dateStr) {
    return operatingDate < poland.dateStr;
  }

  // Same day: compare minutes
  return minutes < (poland.hours * 60 + poland.minutes);
}

/**
 * Checks if actual arrival/departure time is in the past.
 * Prefers departure time (happens after arrival at a station).
 */
export function isActualTimeInPast(
  actualArr: string | null,
  actualDep: string | null,
  operatingDate: string,
  now?: Date,
): boolean {
  const rawTime = actualDep || actualArr;
  return isTimeInPast(rawTime, operatingDate, now);
}

/**
 * Checks if planned arrival/departure time is in the past.
 * Used as fallback when actual times are not available.
 * Prefers departure time.
 */
export function isPlannedTimeInPast(
  plannedDep: string | null,
  plannedArr: string | null,
  operatingDate: string,
  now?: Date,
): boolean {
  const rawTime = plannedDep || plannedArr;
  return isTimeInPast(rawTime, operatingDate, now);
}
