// Japan Standard Time is UTC+9 year-round (no DST).
const JST_OFFSET_MINUTES = 9 * 60;
const DAY_MINUTES = 24 * 60;
export function isJstNotificationTime(now: number): boolean {
  const minutes = ((Math.floor(now / 60_000) + JST_OFFSET_MINUTES) % DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES;
  return minutes >= 9 * 60 && minutes < 20 * 60;
}
