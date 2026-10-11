// Shared HTTP failure handling: a scheduled Worker should never sleep to wait out 429s.
// Store the server-advertised cooldown in D1 and retry on a later Cron invocation.
export class HttpStatusError extends Error {
  constructor(
    readonly source: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(source + ' HTTP ' + status);
    this.name = 'HttpStatusError';
  }
}

export function retryAfterMs(response: Response, now = Date.now()): number | null {
  const header = response.headers.get('Retry-After');
  let seconds: number | null = null;
  if (header !== null) {
    const value = header.trim();
    if (/^\d+(?:\.\d+)?$/.test(value)) {
      seconds = Number(value);
    } else {
      const date = Date.parse(value);
      if (Number.isFinite(date)) seconds = (date - now) / 1000;
    }
  }
  // Discord supplies this as fractional seconds on many rate-limit responses.
  if (seconds === null) {
    const fallback = response.headers.get('X-RateLimit-Reset-After');
    if (fallback !== null && /^\d+(?:\.\d+)?$/.test(fallback.trim())) {
      seconds = Number(fallback.trim());
    }
  }
  return seconds !== null && Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds * 1000) : null;
}

export function requireSuccess(response: Response, source: string, now = Date.now()): void {
  if (response.ok) return;
  throw new HttpStatusError(source, response.status, retryAfterMs(response, now));
}

export function suggestedRetryDelay(error: unknown): number | null {
  return error instanceof HttpStatusError ? error.retryAfterMs : null;
}

export function isRateLimited(error: unknown): boolean {
  return error instanceof HttpStatusError && error.status === 429;
}
