import { readFileSync, writeFileSync } from 'node:fs';
const uuid = process.argv[2];
if (typeof uuid !== 'string' ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
  console.error('Usage: npm run setup:cloudflare -- <your-D1-database-UUID>');
  process.exitCode = 1;
} else {
  const path = new URL('../wrangler.jsonc', import.meta.url);
  const source = readFileSync(path, 'utf8');
  const d1 = /("database_id"\s*:\s*")[0-9a-f-]+(")/gi;
  const matches = [...source.matchAll(d1)];
  if (matches.length !== 1 ||
    !/"binding"\s*:\s*"DB"/.test(source)) {
    console.error('Expected exactly one DB binding in wrangler.jsonc; no changes made');
    process.exitCode = 1;
  } else {
    writeFileSync(path, source.replace(d1, (_, start, end) => start + uuid + end));
    console.log('wrangler.jsonc now points at your D1 database.');
    console.log('Next: npx wrangler d1 migrations apply dopagaki-notify --remote');
    console.log('Then register Discord Webhook Secrets and run npm run deploy.');
  }
}
