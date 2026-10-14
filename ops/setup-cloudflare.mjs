// Generate an account-specific, gitignored Wrangler config from the public
// example. No Cloudflare network access; the UUID is not a credential.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const PLACEHOLDER_D1_ID = '00000000-0000-4000-8000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function configuredD1Id(raw) {
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('Malformed Wrangler config'); }
  const d1 = config?.d1_databases;
  if (!Array.isArray(d1) || d1.length !== 1 || d1[0]?.binding !== 'DB' ||
      typeof d1[0]?.database_id !== 'string' ||
      typeof d1[0]?.database_name !== 'string')
    throw new Error('Expected one DB D1 binding');
  return d1[0].database_id;
}

export function validD1Id(id) {
  return typeof id === 'string' && UUID.test(id) &&
    id.toLowerCase() !== PLACEHOLDER_D1_ID;
}

export function generateConfig(example, id) {
  if (!validD1Id(id)) throw new Error('Expected your own non-placeholder D1 UUID');
  if (configuredD1Id(example).toLowerCase() !== PLACEHOLDER_D1_ID)
    throw new Error('The public Wrangler example must contain the dummy D1 UUID');
  const config = JSON.parse(example);
  config.d1_databases[0].database_id = id.toLowerCase();
  return JSON.stringify(config, null, 2) + '\n';
}

export function prepareConfig({templatePath, outputPath, id}) {
  const generated = generateConfig(readFileSync(templatePath, 'utf8'), id);
  if (existsSync(outputPath)) {
    // Never silently overwrite a different production D1 binding or a
    // customized Wrangler config. Back up/remove it manually to switch.
    const existing = configuredD1Id(readFileSync(outputPath, 'utf8'));
    if (existing.toLowerCase() !== id.toLowerCase())
      throw new Error('Existing Wrangler config points at another D1. Back up and remove it first.');
    return 'unchanged';
  }
  writeFileSync(outputPath, generated, {mode: 0o600, flag: 'wx'});
  return 'created';
}

export function parseSetupId(argv, environmentId) {
  if (argv.length > 1) throw new Error('Usage: npm run setup:cloudflare -- YOUR_D1_DATABASE_UUID');
  if (argv.length === 1 && environmentId)
    throw new Error('Provide the D1 UUID using CLI argument or D1_DATABASE_ID, not both');
  return argv[0] ?? environmentId;
}

async function main() {
  const id = parseSetupId(process.argv.slice(2), process.env.D1_DATABASE_ID);
  if (!validD1Id(id)) throw new Error('Provide a real D1 UUID via argument or D1_DATABASE_ID');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const status = prepareConfig({
    templatePath: resolve(root, 'wrangler.example.jsonc'),
    outputPath: resolve(root, 'wrangler.jsonc'),
    id,
  });
  console.log('Account-local wrangler.jsonc ' + status + '; do not commit.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (err) {
    const allowed = [
      'Expected your own non-placeholder D1 UUID',
      'The public Wrangler example must contain the dummy D1 UUID',
      'Existing Wrangler config points at another D1. Back up and remove it first.',
      'Provide the D1 UUID using CLI argument or D1_DATABASE_ID, not both',
      'Provide a real D1 UUID via argument or D1_DATABASE_ID',
      'Usage: npm run setup:cloudflare -- YOUR_D1_DATABASE_UUID',
    ];
    console.error(err instanceof Error && allowed.includes(err.message)
      ? err.message : 'Local Cloudflare configuration invalid');
    process.exitCode = 1;
  }
}
