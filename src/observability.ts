import { HttpStatusError } from './http.ts';
import type { SourceName } from './types.ts';

// Error-only structured logs: no query strings, fetched content, stack traces,
// Webhook URLs or upstream response bodies are written to application logs.
export interface FailureContext {
  event: 'monitor_failure' | 'cron_failure' | 'runtime_config_failure';
  phase: string;
  monitorId?: string;
  source?: SourceName;
  cron?: string;
  retryAt?: number | null;
  itemId?: string;
}

function safeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
    .replace(/\b(token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]')
    .slice(0, 320);
}

export function failureDetails(error: unknown): {
  errorType: string;
  errorMessage: string;
  httpStatus?: number;
  upstream?: string;
  retryAfterMs?: number | null;
} {
  if (error instanceof HttpStatusError) return {
    errorType: 'HttpStatusError',
    errorMessage: error.source + ' HTTP ' + error.status,
    httpStatus: error.status,
    upstream: error.source,
    retryAfterMs: error.retryAfterMs,
  };
  if (error instanceof Error) return {
    errorType: safeErrorMessage(error.name || 'Error').slice(0, 80),
    errorMessage: safeErrorMessage(error.message),
  };
  return { errorType: 'UnknownThrownValue', errorMessage: 'Non-Error value thrown' };
}

export function logFailure(context: FailureContext, error: unknown): void {
  const { retryAt, ...rest } = context;
  console.error(JSON.stringify({
    ...rest,
    ...(retryAt === null || retryAt === undefined ? {} : { retryAt: new Date(retryAt).toISOString() }),
    ...failureDetails(error),
  }));
}
