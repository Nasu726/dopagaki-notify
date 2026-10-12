import { pruneSentDeliveries } from './maintenance.ts';
import { MONITORS } from './config.ts';
import { runTick } from './runner.ts';
import type { Env } from './types.ts';

export default {
  // There is no public UI/API. This Worker is only used by its Cron Trigger.
  async fetch(_request: Request): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event: { cron?: string }, env: Env): Promise<void> {
    // Hourly retention maintenance runs in a separate scheduled invocation, so its
    // D1 deletion cost never adds to the source-fetch/delivery CPU budget.
    if (event.cron === '10 * * * *') {
      const deleted = await pruneSentDeliveries(env.DB, Date.now());
      if (deleted) console.log('retention: pruned ' + deleted + ' sent delivery receipts');
      return;
    }
    if (event.cron !== '* * * * *') return;
    const status = await runTick(env, MONITORS);
    console.log('cron: ' + status);
  },
};
