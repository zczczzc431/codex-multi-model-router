'use strict';

/**
 * Rebuild <codex home>/router-models.json.
 *
 * Codex reads the router's model catalog from disk, so the catalog has to be
 * regenerated whenever the Codex model cache changes (i.e. after a Codex
 * upgrade) or when a provider config gains/loses models.
 *
 * The catalog is a MERGE:
 *
 *   - Codex's own models come from models_cache.json
 *   - provider models come from each provider config
 *   - anything the router already manages is replaced, never duplicated
 *
 * Provider models fall back to whatever the catalog already holds, so a
 * temporarily unreadable config does not silently drop models from the menu.
 * On a fresh install there is nothing to fall back to, which is why the
 * provider configs can also SEED the catalog.
 *
 * Usage:
 *   node sync-model-catalog.js <cache> <catalog> <backup>
 *                               [relay-models] [workbuddy-models] [deepseek-models]
 *
 * <catalog> may not exist yet; it is created.
 */

const fs = require('node:fs');

const [
  cachePath,
  catalogPath,
  backupPath,
  relayPath,
  workbuddyPath,
  deepseekPath,
] = process.argv.slice(2);

if (!cachePath || !catalogPath || !backupPath) {
  throw new Error(
    'Usage: node sync-model-catalog.js <cache> <catalog> <backup> ' +
      '[relay-models] [workbuddy-models] [deepseek-models]'
  );
}

function readJsonIfPresent(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
if (!Array.isArray(cache.models) || cache.models.length === 0) {
  throw new Error('Codex model cache contains no models');
}

// A missing catalog is normal on first run.
const catalog = readJsonIfPresent(catalogPath) ?? { models: [] };
if (!Array.isArray(catalog.models)) {
  throw new Error('Router model catalog contains no models array');
}

/**
 * Turn a provider config into catalog-shaped entries.
 *
 * The `router` block is routing metadata for the router process only; Codex
 * must never see it, so it is stripped here.
 *
 * An entry is usable when it has a slug and - if it carries a `router` block
 * at all - that block names an upstream model. DeepSeek entries deliberately
 * have no `router` block, because router.js maps their slugs to endpoints
 * itself; demanding routing metadata from every provider would silently drop
 * the entire DeepSeek group from the menu.
 *
 * Returns null when the file is unreadable OR yields no usable entries, so the
 * caller can fall back to the catalog. Returning an empty array here would be
 * truthy, which would defeat that fallback instead.
 */
function loadProviderModels(file) {
  const parsed = readJsonIfPresent(file);
  if (!parsed) return null;
  const defaults = parsed.modelDefaults ?? {};
  const models = [];
  for (const model of parsed.models ?? []) {
    const { router: routing, ...rest } = model;
    if (!rest.slug) continue;
    if (routing && !routing.upstream_model) continue;
    models.push({ ...defaults, ...rest });
  }
  return models.length > 0 ? models : null;
}

/**
 * Provider models, in priority order:
 *   1. the provider config on disk (authoritative when readable)
 *   2. whatever the existing catalog already has for that prefix
 *   3. nothing - warn rather than throw, so one broken provider cannot take
 *      the whole model menu down
 */
function resolveGroup(label, prefix, configPath) {
  const fromConfig = loadProviderModels(configPath);
  if (fromConfig) return fromConfig;

  const fromCatalog = catalog.models.filter((m) => String(m.slug).startsWith(prefix));
  if (fromCatalog.length > 0) return fromCatalog;

  process.stdout.write(
    `${label} models: none configured and none in the catalog; skipping. ` +
      `Provide ${configPath ?? 'the provider config'} to enable them.\n`
  );
  return [];
}

const deepSeekSource = resolveGroup('DeepSeek', 'deepseek-', deepseekPath);
const relaySource = resolveGroup('relay', 'relay-', relayPath);
const workbuddySource = resolveGroup('workbuddy', 'wb-', workbuddyPath);

// Every generated entry inherits the shape of a real Codex model entry, so the
// picker renders it like any built-in model.
const template =
  cache.models.find((model) => model.visibility === 'list') ?? cache.models[0];

const isRouterManaged = (model) =>
  String(model.slug).startsWith('deepseek-') ||
  String(model.slug).startsWith('relay-') ||
  String(model.slug).startsWith('wb-');

const mergedModels = [
  ...cache.models.filter((model) => !isRouterManaged(model)),
  ...deepSeekSource.map((model) => ({ ...template, ...model })),
  ...relaySource.map((model) => ({ ...template, ...model })),
  ...workbuddySource.map((model) => ({ ...template, ...model })),
];

const nextCatalog = { ...catalog, models: mergedModels };
const nextText = `${JSON.stringify(nextCatalog, null, 2)}\n`;
const currentText = fs.existsSync(catalogPath)
  ? fs.readFileSync(catalogPath, 'utf8')
  : '';

const summary =
  `${cache.models.length} Codex + ${deepSeekSource.length} DeepSeek + ` +
  `${relaySource.length} relay + ${workbuddySource.length} workbuddy models`;

if (currentText !== nextText) {
  if (currentText) fs.copyFileSync(catalogPath, backupPath);
  const temporaryPath = `${catalogPath}.tmp`;
  fs.writeFileSync(temporaryPath, nextText);
  fs.renameSync(temporaryPath, catalogPath);
  process.stdout.write(`catalog synchronized: ${summary}`);
} else {
  process.stdout.write(`catalog already current: ${summary}`);
}
