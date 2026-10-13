// Read-only preflight. Shared parsers ensure CI and operator checks follow
// the same constraints as the Cloudflare Worker runtime.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRuntimeMonitors, resolveNotificationWindowJst, validateMonitors } from '../src/config.ts';

export function validateRuntimeConfiguration(privateJson, windowSecret) {
  let monitors;
  try {
    monitors = loadRuntimeMonitors(privateJson);
    validateMonitors(monitors);
  } catch {
    // Never echo the private JSON, queries, or source identifiers.
    throw new Error('Monitor config invalid: inspect target types, IDs, intervals and private JSON');
  }
  let deliveryWindow;
  try {
    deliveryWindow = resolveNotificationWindowJst(privateJson, windowSecret);
  } catch {
    // In particular, 24:00 is not HH:MM, and start=end is not a 24h window.
    throw new Error('Delivery window invalid: use HH:MM-HH:MM (end-exclusive, 00:00-23:59) or unset NOTIFICATION_WINDOW_JST for 24h');
  }
  return {
    ok: true,
    monitorCount: monitors.length,
    enabledCount: monitors.filter((m) => m.enabled).length,
    notificationWindow: deliveryWindow === null ? 'unrestricted-24h' : 'restricted-JST',
  };
}

export function parsePreflightArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const parsed = { help: false, configFile: null, windowFile: null };
  for (const arg of args) {
    if (arg.startsWith('--private-config-file=') && !parsed.configFile) {
      parsed.configFile = arg.slice('--private-config-file='.length);
    } else if (arg.startsWith('--notification-window-file=') && !parsed.windowFile) {
      parsed.windowFile = arg.slice('--notification-window-file='.length);
    } else {
      throw new Error('Unknown or repeated preflight option');
    }
  }
  if (parsed.configFile === '' || parsed.windowFile === '')
    throw new Error('Missing preflight file path');
  return parsed;
}

async function main() {
  const args = parsePreflightArgs(process.argv.slice(2));
  if (args.help) {
    console.log([
      'Usage: npm run config:check -- [--private-config-file=.private/monitor-config.json]',
      '      [--notification-window-file=.private/notification-window.txt]',
      'Without options, checks public committed configuration and any private',
      'MONITOR_CONFIG_JSON / NOTIFICATION_WINDOW_JST already in local environment.',
      'No D1 access, no API requests and no secrets written or echoed.',
      'For 24h sending, unset NOTIFICATION_WINDOW_JST (00:00-24:00 is invalid).',
    ].join('\n'));
    return;
  }
  if ((args.configFile && process.env.MONITOR_CONFIG_JSON !== undefined) ||
      (args.windowFile && process.env.NOTIFICATION_WINDOW_JST !== undefined))
    throw new Error('Choose environment or local file for each private setting, not both');
  const config = args.configFile
    ? readFileSync(args.configFile, 'utf8') : process.env.MONITOR_CONFIG_JSON;
  const window = args.windowFile
    ? readFileSync(args.windowFile, 'utf8').trim() : process.env.NOTIFICATION_WINDOW_JST;
  console.log(JSON.stringify(validateRuntimeConfiguration(config, window)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    // One actionable line, no paths, raw inputs or user secrets.
    const message = error instanceof Error && (
      error.message.startsWith('Monitor config invalid:') ||
      error.message.startsWith('Delivery window invalid:')) ? error.message
      : 'Preflight setup invalid: check private file paths and duplicate environment options';
    console.error(JSON.stringify({ok:false, event:'config_preflight_failed', message}));
    process.exitCode = 1;
  }
}
