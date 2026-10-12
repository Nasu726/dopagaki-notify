// Japan Standard Time is UTC+9 year-round (no DST).
const JST_OFFSET_MINUTES = 9 * 60;
const DAY_MINUTES = 24 * 60;
export function isJstNotificationTime(now: number): boolean {
  const minutes = ((Math.floor(now / 60_000) + JST_OFFSET_MINUTES) % DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES;
  return minutes >= 9 * 60 && minutes < 20 * 60;
}

/** Weekday schedule uses JST (UTC+9, no daylight-saving transition). */
const JST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
export const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const;

export function isWeeklyJstDay(value: string): boolean {
  return WEEKDAYS.some((day) => day === value);
}

/**
 * The next selected weekday at 09:00 JST, strictly later than 'now'.
 * Always use UTC calendar functions on the JST-adjusted timestamp.
 * No time-zone/DST settings of the Cloudflare Worker are consulted.
 */
export function nextWeeklyJstDue(now: number, weekday: string): number {
  const weekdayIndex: number = WEEKDAYS.findIndex((day) => day === weekday);
  if (weekdayIndex === -1 || !Number.isFinite(now)) throw new Error('Invalid weekly JST schedule');
  const local = new Date(now + JST_OFFSET_MS);
  const daysAhead = (weekdayIndex - local.getUTCDay() + 7) % 7;
  let due = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + daysAhead, 9, 0, 0, 0,
  ) - JST_OFFSET_MS;
  if (due <= now) due += 7 * DAY_MS;
  return due;
}
