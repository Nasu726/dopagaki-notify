import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpStatusError } from '../src/http.ts';
import { failureDetails, logFailure } from '../src/observability.ts';

test('HTTP error summary includes provider, status and server retry hint', () => {
  assert.deepEqual(failureDetails(new HttpStatusError('MediaWiki', 403, 3_000)), {
    errorType: 'HttpStatusError',
    errorMessage: 'MediaWiki HTTP 403',
    httpStatus: 403,
    upstream: 'MediaWiki',
    retryAfterMs: 3_000,
  });
});

test('logged exceptions redact URLs and credentials and do not include stack traces', () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    logFailure({ event: 'monitor_failure', phase: 'fetch_and_parse',
      monitorId: 'youtube-example', source: 'youtube' },
    new Error('Fetch failed at https://discord.com/api/webhooks/123/topsecret?foo=bar Bearer supersecret token=anothersecret'));
  } finally { console.error = original; }
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0]!, /topsecret|supersecret|anothersecret|https:\/\//);
  const message = JSON.parse(logged[0]!) as Record<string, unknown>;
  assert.equal(message.event, 'monitor_failure');
  assert.equal(message.monitorId, 'youtube-example');
  assert.equal(message.phase, 'fetch_and_parse');
  assert.equal(message.errorType, 'Error');
  assert.equal(message.retryAt, undefined);
  assert.equal(message.stack, undefined);
});

test('arbitrary thrown values are not serialized into logs', () => {
  assert.deepEqual(failureDetails({ secret: 'sensitive' }), {
    errorType: 'UnknownThrownValue',
    errorMessage: 'Non-Error value thrown',
  });
});
