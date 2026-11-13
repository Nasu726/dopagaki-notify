import { loadRuntimeMonitors } from '../../src/config.ts';

/** GitHub Actions defaults to private mode to prevent a newly enabled workflow
 * from silently using the original author's public subscription examples.
 * Public mode is only entered by an explicit repository Variables setting.
 */
export function selectActionsConfig(rawMode, rawPrivateConfig) {
  const mode = rawMode === undefined || rawMode === '' ? 'private' : rawMode;
  if (mode !== 'public' && mode !== 'private')
    throw new Error('MONITOR_CONFIG_MODE must be public or private');
  if (mode === 'private') {
    if (typeof rawPrivateConfig !== 'string' || !rawPrivateConfig.trim())
      throw new Error('Private mode requires MONITOR_CONFIG_JSON Actions Secret');
    return { mode, configJson: rawPrivateConfig, monitors: loadRuntimeMonitors(rawPrivateConfig) };
  }
  if (rawPrivateConfig !== undefined && rawPrivateConfig !== '')
    throw new Error('Public mode conflicts with existing MONITOR_CONFIG_JSON; remove private Secret first');
  return { mode, configJson: undefined, monitors: loadRuntimeMonitors(undefined) };
}

/** `${{ secrets.X }}` / `${{ vars.X }}` evaluate to '' when the Secret or
 * Variable is not registered, whereas a Cloudflare Worker sees `undefined`.
 * Normalize exactly '' to "not configured" so optional settings (for example
 * OPENALEX_API_KEY) are not mistaken for deliberately invalid values.
 * Any other value, including whitespace, is passed through for validation.
 */
function configured(value) {
  return value === '' ? undefined : value;
}

/** Build the Worker-compatible runtime environment for one Actions run. */
export function buildActionsEnv(source, configJson) {
  const repository = configured(source.GITHUB_REPOSITORY);
  return {
    MONITOR_CONFIG_JSON: configJson,
    NOTIFICATION_WINDOW_JST: configured(source.NOTIFICATION_WINDOW_JST),
    // GitHub Actions defaults to the fork's own repository as the contact.
    WIKIMEDIA_CONTACT_URL: configured(source.WIKIMEDIA_CONTACT_URL) ??
      (repository ? 'https://github.com/' + repository : undefined),
    DISCORD_WEBHOOK_QIITA: configured(source.DISCORD_WEBHOOK_QIITA),
    DISCORD_WEBHOOK_ZENN: configured(source.DISCORD_WEBHOOK_ZENN),
    DISCORD_WEBHOOK_ARXIV: configured(source.DISCORD_WEBHOOK_ARXIV),
    DISCORD_WEBHOOK_OPENALEX: configured(source.DISCORD_WEBHOOK_OPENALEX),
    OPENALEX_API_KEY: configured(source.OPENALEX_API_KEY),
    DISCORD_WEBHOOK_YOUTUBE: configured(source.DISCORD_WEBHOOK_YOUTUBE),
    YOUTUBE_API_KEY: configured(source.YOUTUBE_API_KEY),
    DISCORD_WEBHOOK_WIKIPEDIA: configured(source.DISCORD_WEBHOOK_WIKIPEDIA),
  };
}
