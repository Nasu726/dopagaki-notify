import { pruneSentDeliveries } from './maintenance.ts';
import { MONITORS } from './config.ts';
import { runTick } from './runner.ts';
import { logFailure } from './observability.ts';
import type { Env } from './types.ts';

export default {
  // There is no public UI/API. This Worker is only used by its Cron Trigger.
  async fetch(_request: Request): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event: { cron?: string }, env: Env): Promise<void> {
    let phase = 'select_cron';
    try {
      // Separate retention invocation keeps its D1 deletion cost outside polling.
      if (event.cron === '10 * * * *') {
        phase = 'retention';
        const deleted = await pruneSentDeliveries(env.DB, Date.now());
        if (deleted) console.log('retention: pruned ' + deleted + ' sent delivery receipts');
        return;
      }
      if (event.cron !== '*/5 * * * *') return;
      phase = 'monitor_tick';
      const status = await runTick(env, MONITORS);
      console.log('cron: ' + status);
    } catch (error) {
      // Complement monitor-specific failures with one Cron-level record.
      // Rethrow to preserve Cloudflare's outcome=exception signal.
      logFailure({ event: 'cron_failure', phase, cron: event.cron }, error);
      throw error;
    }
  },
};
