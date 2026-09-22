const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const OUT = process.env.WORKBUDDY_HARVEST_OUT;
if (!OUT) { console.error('WORKBUDDY_HARVEST_OUT is required'); process.exit(2); }

const NODE_EXE = process.env.WORKBUDDY_NODE_EXE || process.execPath;
const CLI = process.env.WORKBUDDY_CODEBUDDY_EXE || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
if (!fs.existsSync(CLI)) { console.error('CodeBuddy CLI not found: ' + CLI); process.exit(3); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbharvest-'));
const hookPath = path.join(tmpDir, 'hook.cjs');
const logPath = path.join(tmpDir, 'spy.log');

const hookLines = [
  "const fs = require('fs');",
  "const os = require('os');",
  "const logFile = process.env.CBC_SPY_LOG;",
  "function rec(o){ try { fs.appendFileSync(logFile, JSON.stringify(o) + os.EOL); } catch {} }",
  "function toObj(h){ if(!h) return null; try { const o={}; for(const k of Object.keys(h)) o[k]=h[k]; return o; } catch { return null; } }",
  "const https = require('https');",
  "const orig = https.request;",
  "https.request = function(){",
  "  try {",
  "    const a = arguments[0];",
  "    if (a && typeof a === 'object' && a.headers) rec({ path: a.path, headers: toObj(a.headers) });",
  "  } catch {}",
  "  return orig.apply(this, arguments);",
  "};",
  "const origFetch = globalThis.fetch;",
  "globalThis.fetch = function(input, init){",
  "  try {",
  "    const url = typeof input === 'string' ? input : (input && input.url) || '';",
  "    const h = (init && init.headers) || (input && input.headers);",
  "    rec({ path: url, headers: toObj(h) });",
  "  } catch {}",
  "  return origFetch.apply(this, arguments);",
  "};",
];
fs.writeFileSync(hookPath, hookLines.join(String.fromCharCode(10)));

const env = Object.assign({}, process.env, {
  CBC_SPY_LOG: logPath,
  CODEBUDDY_FORCE_HEADLESS_BUNDLE: '1',
  NODE_OPTIONS: '--require ' + hookPath,
});

const run = spawnSync(NODE_EXE, [CLI, '-p', '--output-format', 'json', '--model', 'deepseek-v4.1-flash', 'ok'], {
  env,
  encoding: 'utf8',
  timeout: 180000,
  windowsHide: true,
});

let accessToken = '';
let refreshToken = '';
try {
  const rows = fs.readFileSync(logPath, 'utf8').split(String.fromCharCode(10));
  for (const row of rows) {
    const line = row.trim();
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const h = o.headers || {};
    if (!accessToken && h.Authorization && String(h.Authorization).indexOf('Bearer ') === 0) accessToken = String(h.Authorization).slice(7);
    if (!refreshToken && h['X-Refresh-Token']) refreshToken = String(h['X-Refresh-Token']);
  }
} catch (e) {
  console.error('could not read harvest log: ' + e.message);
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

if (!accessToken || !refreshToken) {
  console.error('harvest failed: access=' + (accessToken ? 'yes' : 'no') + ' refresh=' + (refreshToken ? 'yes' : 'no'));
  console.error('cli exit=' + run.status + ' stderr tail=' + String(run.stderr || '').slice(-300));
  process.exit(4);
}

fs.writeFileSync(OUT, JSON.stringify({ accessToken, refreshToken, harvestedAt: new Date().toISOString() }), 'utf8');
console.log('harvested ok accessLen=' + accessToken.length + ' refreshLen=' + refreshToken.length);

