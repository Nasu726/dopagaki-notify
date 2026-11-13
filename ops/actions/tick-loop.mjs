// GitHub Actions-only scheduling loop. The Cloudflare Worker is unchanged:
// it still processes one monitor per five-minute Cron invocation.
import { runTick } from '../../src/runner.ts';
import { validateMonitors, resolveNotificationWindowJst } from '../../src/config.ts';
import { getRunnableIds } from '../../src/state.ts';
import { hasWebhookSecret } from '../../src/discord.ts';

/** Stop starting new monitors after this much wall time; the job limit is 10 minutes. */
export const ACTIONS_TICK_BUDGET_MS = 4 * 60_000;

/**
 * A Worker Cron tick handles one monitor and Cloudflare fires twelve per hour.
 * GitHub's schedule starts at most six runs per hour (often fewer), so a
 * single tick per run starves monitors as soon as there are several.
 *
 * Visit each monitor that is runnable when this run starts exactly once, in
 * the same priority order the Worker uses. Each visit is an ordinary runTick
 * call restricted to that monitor, so per-monitor fetch scheduling, leases,
 * delivery windows, the three-notification batch and Discord 429 cooldowns
 * are identical to the Worker. A monitor is never revisited in the same run,
 * so a backlog is not drained faster than one batch per monitor per run.
 *
 * Failures of one monitor do not stop the others; they are counted so the
 * caller can still mark the run as failed after saving state.
 */
export async function runDueMonitorsOnce(env, monitors, options = {}) {
  const clock = options.clock ?? Date.now;
  const budgetMs = options.budgetMs ?? ACTIONS_TICK_BUDGET_MS;
  validateMonitors(monitors);
  const deliveryWindow = resolveNotificationWindowJst(
    env.MONITOR_CONFIG_JSON, env.NOTIFICATION_WINDOW_JST,
  );
  // Same dormancy rule as runTick: no state rows for monitors without a webhook.
  const candidates = monitors.filter((monitor) => monitor.enabled && hasWebhookSecret(monitor, env));
  const summary = { processed: 0, failed: 0, deferred: 0 };
  if (!candidates.length) return summary;
  const byId = new Map(candidates.map((monitor) => [monitor.id, monitor]));
  const startedAt = clock();
  const order = (await getRunnableIds(env.DB, startedAt, candidates, deliveryWindow))
    .filter((id) => byId.has(id));
  for (const id of order) {
    if (clock() - startedAt >= budgetMs) {
      // Still due; it keeps its priority for the next scheduled run.
      summary.deferred++;
      continue;
    }
    try {
      const status = await runTick(env, [byId.get(id)], clock(), options.deps);
      if (status === 'processed') summary.processed++;
    } catch {
      // runTick has already persisted retry state and logged (silenced) details.
      summary.failed++;
    }
  }
  return summary;
}
