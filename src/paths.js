'use strict';

/**
 * Central path resolution for the router.
 *
 * Everything the router reads at runtime (model catalogs, the log file, the
 * encrypted credential blobs) lives in the Codex home directory, because that
 * is what Codex itself already uses and what the launcher scripts target.
 *
 * Resolution order:
 *   1. CODEX_ROUTER_HOME  - explicit override, useful for testing
 *   2. CODEX_HOME         - Codex's own variable, honoured when set
 *   3. ~/.codex           - Codex's default
 */

const os = require('node:os');
const path = require('node:path');

const CODEX_HOME =
  process.env.CODEX_ROUTER_HOME ||
  process.env.CODEX_HOME ||
  path.join(os.homedir(), '.codex');

/** Directory containing this file. */
const SRC_DIR = __dirname;

module.exports = {
  CODEX_HOME,
  SRC_DIR,

  // Runtime artefacts
  routerLog: path.join(CODEX_HOME, 'codex-model-router.log'),
  routerDumpFlag: path.join(CODEX_HOME, 'router-dump.enabled'),
  routerDumpFile: path.join(CODEX_HOME, 'router-body-dump.jsonl'),

  // Hand-maintained provider catalogs
  relayConfig: path.join(CODEX_HOME, 'relay-models.json'),
  workbuddyConfig: path.join(CODEX_HOME, 'workbuddy-models.json'),

  // Generated/derived catalogs
  modelsCache: path.join(CODEX_HOME, 'models_cache.json'),
  routerModels: path.join(CODEX_HOME, 'router-models.json'),
  routerModelsLastGood: path.join(CODEX_HOME, 'router-models.last-good.json'),
  routerFingerprint: path.join(CODEX_HOME, 'codex-router-files.sha256'),
  codexCliVersionFile: path.join(CODEX_HOME, 'codex-router-last-cli-version.txt'),

  // Encrypted credentials (Windows DPAPI)
  deepseekKeyFile: path.join(CODEX_HOME, 'deepseek-api-key.dpapi'),
  workbuddyTokenFile: path.join(CODEX_HOME, 'workbuddy-token.dpapi'),

  // Config that Codex itself reads
  codexConfig: path.join(CODEX_HOME, 'config.toml'),
};
