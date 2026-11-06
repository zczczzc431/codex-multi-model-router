import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../src/sync-model-catalog.js', import.meta.url));

async function runSync({ official, existing, providers = {} }) {
  const root = path.join(tmpdir(), `catalog-sync-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  const cache = path.join(root, 'official-models.json');
  const catalog = path.join(root, 'router-models.json');
  const backup = path.join(root, 'router-models.last-good.json');
  const relay = path.join(root, 'relay-models.json');
  const workbuddy = path.join(root, 'workbuddy-models.json');
  const deepseek = path.join(root, 'deepseek-models.json');

  await writeFile(cache, JSON.stringify({ models: official }, null, 2));
  await writeFile(catalog, JSON.stringify({ models: existing }, null, 2));
  await writeFile(relay, JSON.stringify(providers.relay ?? { models: [] }, null, 2));
  await writeFile(workbuddy, JSON.stringify(providers.workbuddy ?? { models: [] }, null, 2));
  await writeFile(deepseek, JSON.stringify(providers.deepseek ?? { models: [] }, null, 2));

  const result = spawnSync(process.execPath, [script, cache, catalog, backup, relay, workbuddy, deepseek], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(await readFile(catalog, 'utf8'));
  return { parsed, stdout: result.stdout.trim() };
}

test('official catalog omits models that are no longer available', async () => {
  const { parsed, stdout } = await runSync({
    official: [{ slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list' }],
    existing: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' }],
  });

  const slugs = parsed.models.map((model) => model.slug);
  assert.ok(!slugs.includes('gpt-6.1-sol'));
  assert.ok(slugs.includes('gpt-6-luna'));
  assert.match(stdout, /1 omitted/);
  assert.match(stdout, /Official models omitted.*gpt-6\.1-sol/);
});

test('official updates replace old metadata without duplicating slugs', async () => {
  const { parsed } = await runSync({
    official: [{ slug: 'gpt-6-luna', display_name: 'GPT-6-Luna New', visibility: 'list' }],
    existing: [{ slug: 'gpt-6-luna', display_name: 'GPT-6-Luna Old', visibility: 'list' }],
  });

  const lunas = parsed.models.filter((model) => model.slug === 'gpt-6-luna');
  assert.equal(lunas.length, 1);
  assert.equal(lunas[0].display_name, 'GPT-6-Luna New');
});

test('provider models remain present alongside available Codex models', async () => {
  const { parsed } = await runSync({
    official: [{ slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list' }],
    existing: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' }],
    providers: {
      deepseek: { models: [{ slug: 'deepseek-flash', display_name: 'DeepSeek-Flash' }] },
    },
  });

  const slugs = parsed.models.map((model) => model.slug);
  assert.deepEqual(slugs, ['gpt-6-luna', 'deepseek-flash']);
});
