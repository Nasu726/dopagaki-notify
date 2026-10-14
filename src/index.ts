import { pruneSentDeliveries } from './maintenance.ts';
import { loadRuntimeMonitors, validateMonitors, resolveNotificationWindowJst } from './config.ts';
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
        const monitors = loadRuntimeMonitors(env.MONITOR_CONFIG_JSON);
        validateMonitors(monitors);
        const deleted = await pruneSentDeliveries(env.DB, Date.now(), monitors);
        if (deleted) console.log('retention: pruned ' + deleted + ' sent delivery receipts');
        return;
      }
      if (event.cron !== '*/5 * * * *') return;
      // Validate both monitor roster and private delivery-window Secrets
      // before touching D1, so a bad deployment fails closed with one
      // actionable, secret-free configuration event per Cron invocation.
      phase = 'monitor_config';
      const monitors = loadRuntimeMonitors(env.MONITOR_CONFIG_JSON);
      validateMonitors(monitors);
      phase = 'delivery_window_config';
      resolveNotificationWindowJst(env.MONITOR_CONFIG_JSON, env.NOTIFICATION_WINDOW_JST);
      phase = 'monitor_tick';
      const status = await runTick(env, monitors);
      console.log('cron: ' + status);
    } catch (error) {
      // Complement monitor-specific failures with one Cron-level record.
      // Rethrow to preserve Cloudflare's outcome=exception signal.
      if (phase === 'monitor_config' || phase === 'delivery_window_config') {
        // Never log an untrusted private Secret or detailed validation error.
        // Retain outcome=exception so failures remain observable to Cloudflare.
        logFailure({ event: 'runtime_config_failure', phase, cron: event.cron },
          new Error(phase === 'delivery_window_config'
            ? 'Invalid notification window. Run npm run config:check -- --notification-window=HH:MM-HH:MM locally, then update Cloudflare Secret.'
            : 'Invalid monitor configuration. Run npm run config:check with the intended local private config.'));
        throw new Error('Invalid runtime configuration; check Cloudflare Secrets and configuration preflight');
      }
      logFailure({ event: 'cron_failure', phase, cron: event.cron }, error);
      throw error;
    }
  },
};
