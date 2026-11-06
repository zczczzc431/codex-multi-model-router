import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('router can load with a nonexistent state directory and no optional catalogs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'router-fresh-'));
  try {
    const state = path.join(root, 'state');
    const entry = fileURLToPath(new URL('../src/router.js', import.meta.url));
    const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', entry], {
      env: { ...process.env, CODEX_ROUTER_HOME: state, DEEPSEEK_API_KEY: 'test-key' },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await stat(state)).isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
