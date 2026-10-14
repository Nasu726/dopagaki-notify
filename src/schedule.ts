// Japan Standard Time is UTC+9 year-round (no DST).
const JST_OFFSET_MINUTES = 9 * 60;
const DAY_MINUTES = 24 * 60;

/** End-exclusive optional local-time delivery window. null means 24-hour sending. */
export interface NotificationWindowJst {
  readonly startMinutes: number;
  readonly endMinutes: number;
}

export function parseNotificationWindowJst(value: unknown): NotificationWindowJst | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('Notification window must be HH:MM-HH:MM or null');
  const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) throw new Error('Notification window must be HH:MM-HH:MM (JST)');
  const startMinutes = Number(match[1]) * 60 + Number(match[2]);
  const endMinutes = Number(match[3]) * 60 + Number(match[4]);
  if (startMinutes === endMinutes)
    throw new Error('Notification window start and end must differ (use null for 24-hour sending)');
  return { startMinutes, endMinutes };
}

export function isJstNotificationTime(now: number, window: NotificationWindowJst | null = null): boolean {
  if (window === null) return true;
  const minutes = ((Math.floor(now / 60_000) + JST_OFFSET_MINUTES) % DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES;
  const { startMinutes, endMinutes } = window;
  return startMinutes < endMinutes
    ? minutes >= startMinutes && minutes < endMinutes
    : minutes >= startMinutes || minutes < endMinutes;
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

/** Earliest permitted JST weekday at or after now + minimum interval.
 * A queued late Cron starts its next interval from actual execution, not
 * from a fixed hourly slot; if the interval crosses the weekday boundary,
 * defer until that weekday next recurs. No restriction to 60-minute polling.
 */
export function nextAllowedJstWeekdayDue(now: number, weekday: string, intervalMinutes: number): number {
  const weekdayIndex = WEEKDAYS.findIndex(day => day === weekday);
  if (weekdayIndex < 0 || !Number.isFinite(now) ||
      !Number.isSafeInteger(intervalMinutes) || intervalMinutes < 0)
    throw new Error('Invalid weekly JST schedule or interval');
  const candidate = now + intervalMinutes * 60_000;
  if (!Number.isFinite(candidate)) throw new Error('Invalid weekly scheduling horizon');
  const local = new Date(candidate + JST_OFFSET_MS);
  const offsetDays = (weekdayIndex - local.getUTCDay() + 7) % 7;
  if (offsetDays === 0) return candidate;
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(),
    local.getUTCDate() + offsetDays, 0) - JST_OFFSET_MS;
}
