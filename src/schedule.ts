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

/** Is 'now' on the selected JST day of the week? */
export function isJstWeekday(now: number, weekday: string): boolean {
  if (!isWeeklyJstDay(weekday) || !Number.isFinite(now))
    throw new Error('Invalid weekly JST schedule');
  return WEEKDAYS[new Date(now + JST_OFFSET_MS).getUTCDay()] === weekday;
}

/**
 * First start of an hour strictly after now, restricted to the selected JST
 * weekday (00:00, 01:00, ... 23:00). If today is not that weekday, return
 * 00:00 JST on the next occurrence. Pure UTC arithmetic avoids host timezone
 * and DST dependence.
 */
export function nextHourlyJstWeekdayDue(now: number, weekday: string): number {
  const index = WEEKDAYS.findIndex((day) => day === weekday);
  if (index < 0 || !Number.isFinite(now)) throw new Error('Invalid weekly JST schedule');
  const local = new Date(now + JST_OFFSET_MS);
  const daysAhead = (index - local.getUTCDay() + 7) % 7;
  if (daysAhead === 0 && local.getUTCHours() < 23) {
    const topOfNextHour = Date.UTC(
      local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
      local.getUTCHours() + 1,
    ) - JST_OFFSET_MS;
    if (topOfNextHour > now) return topOfNextHour;
  }
  const skip = daysAhead === 0 ? 7 : daysAhead;
  return Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + skip, 0,
  ) - JST_OFFSET_MS;
}
