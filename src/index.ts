import { MONITORS } from './config.ts';
import { runTick } from './runner.ts';
import type { Env } from './types.ts';

export default {
  // There is no public UI/API. This Worker is only used by its Cron Trigger.
  async fetch(_request: Request): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const status = await runTick(env, MONITORS);
    console.log('cron: ' + status);
  },
};
