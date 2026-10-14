import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredD1Id,validD1Id,generateConfig,prepareConfig,parseSetupId,PLACEHOLDER_D1_ID} from '../ops/setup-cloudflare.mjs';

const example = readFileSync(new URL('../wrangler.example.jsonc',import.meta.url),'utf8');
const own='12345678-1234-4123-8123-123456789abc';
const other='87654321-1234-4123-8123-123456789abc';

test('published Wrangler file contains dummy ID only and generated file is gitignored',()=>{
  assert.equal(configuredD1Id(example),PLACEHOLDER_D1_ID);
  assert.equal(validD1Id(PLACEHOLDER_D1_ID),false);
  assert.equal(validD1Id(own),true);
  assert.equal(validD1Id('not-a-uuid'),false);
  const ignore=readFileSync(new URL('../.gitignore',import.meta.url),'utf8');
  assert.match(ignore,/^\/wrangler\.jsonc\s*$/m);
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.ok(pkg.scripts['bundle:check'].includes('--config wrangler.example.jsonc'));
  assert.ok(pkg.scripts.predeploy.includes('verify-cloudflare-config'));
});

test('setup generates private D1 binding without changing Worker or schedule fields',()=>{
  const output=generateConfig(example,own);
  const parsed=JSON.parse(output);
  assert.equal(configuredD1Id(output),own);
  assert.equal(parsed.name,'dopagaki-notify');
  assert.equal(parsed.main,'src/index.ts');
  assert.deepEqual(parsed.triggers.crons,['*/5 * * * *','10 * * * *']);
  assert.equal(parsed.d1_databases[0].binding,'DB');
  assert.equal(parsed.d1_databases[0].migrations_dir,'migrations');
  assert.equal(configuredD1Id(example),PLACEHOLDER_D1_ID,'example remains unchanged');
  assert.ok(!example.includes(own));
  assert.throws(()=>generateConfig(example,PLACEHOLDER_D1_ID));
  assert.throws(()=>generateConfig(output,other),'cannot turn an already configured file into a template');
});

test('setup never overwrites a different existing production binding',()=>{
  const root=mkdtempSync(join(tmpdir(),'d1-setup-'));
  const templatePath=join(root,'example.jsonc'),outputPath=join(root,'wrangler.jsonc');
  try {
    writeFileSync(templatePath,example);
    assert.equal(prepareConfig({templatePath,outputPath,id:own}),'created');
    assert.equal(existsSync(outputPath),true);
    assert.equal(prepareConfig({templatePath,outputPath,id:own}),'unchanged');
    assert.throws(()=>prepareConfig({templatePath,outputPath,id:other}),/another D1/);
    assert.equal(configuredD1Id(readFileSync(outputPath,'utf8')),own);
  }finally{rmSync(root,{force:true,recursive:true})}
});

test('setup accepts explicit CLI UUID or build environment but never mixes both',()=>{
  assert.equal(parseSetupId([own],undefined),own);
  assert.equal(parseSetupId([],own),own);
  assert.throws(()=>parseSetupId([own],other),/not both/);
  assert.throws(()=>parseSetupId([own,other],undefined),/Usage/);
});
