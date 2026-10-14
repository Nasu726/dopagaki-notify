// Fail closed rather than letting Wrangler autoconfigure a deployment with
// no D1 binding when setup has not been performed.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {configuredD1Id,validD1Id} from './setup-cloudflare.mjs';
try {
  const config=readFileSync(fileURLToPath(new URL('../wrangler.jsonc',import.meta.url)),'utf8');
  if (!validD1Id(configuredD1Id(config))) throw new Error('Missing D1 setup');
  console.log('Local Cloudflare D1 binding validated (UUID redacted).');
} catch {
  console.error('Cloudflare D1 unconfigured: run npm run setup:cloudflare -- YOUR_D1_DATABASE_UUID first.');
  process.exitCode = 1;
}
