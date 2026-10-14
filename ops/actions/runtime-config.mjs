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
