'use strict';
// WorkBuddy (Tencent CodeBuddy) adapter for the Codex model router.
// Translates the OpenAI Responses API used by Codex into the streaming
// chat/completions API exposed by copilot.tencent.com, and translates the
// returned deltas back into Responses API server-sent events.

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOST = 'copilot.tencent.com';
const CHAT_PATH = '/v2/chat/completions';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';
const paths = require('./paths');
const TOKEN_FILE = paths.workbuddyTokenFile;
const SAVE_SCRIPT = require('node:path').join(paths.SRC_DIR, '..', 'scripts', 'Save-WorkBuddyToken.ps1')

function logTo(file, message) {
  if (!file) return;
  try { fs.appendFileSync(file, new Date().toISOString() + ' ' + message + String.fromCharCode(10)); } catch {}
}

function decodeJwtExp(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number(payload.exp || 0) * 1000;
  } catch { return 0; }
}

function loadAuth() {
  const raw = process.env.WORKBUDDY_AUTH_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return parsed;
  } catch { return null; }
}

function baseHeaders(auth) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Accept-Encoding': 'identity',
    'User-Agent': 'CLI/2.156.0',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Product': 'SaaS',
    'X-Domain': 'www.codebuddy.cn',
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': '2.156.0',
  };
  if (auth && auth.accessToken) headers.Authorization = 'Bearer ' + auth.accessToken;
  return headers;
}

function postJson(pathName, headers, bodyText) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, path: pathName, method: 'POST', headers
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('token request timeout')); });
    req.end(bodyText || '');
  });
}

function persistAuth(auth, logFile) {
  let child;
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SAVE_SCRIPT], {
      stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
    });
  } catch (e) {
    logTo(logFile, 'persist spawn failed: ' + e.message);
    return;
  }
  child.on('error', () => {});
  try { child.stdin.end(JSON.stringify({ accessToken: auth.accessToken, refreshToken: auth.refreshToken })); } catch {}
}

function createWorkBuddyClient(options) {
  const logFile = options.logFile;
  let auth = loadAuth();
  let refreshing = null;

  async function ensureAuth() {
    if (!auth) return null;
    const exp = decodeJwtExp(auth.accessToken);
    const soon = Date.now() + 5 * 60 * 1000;
    if (exp && exp > soon) return auth;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const res = await postJson(REFRESH_PATH, Object.assign(baseHeaders(null), {
          'X-Refresh-Token': auth.refreshToken,
          'Accept': 'application/json, text/plain, */*',
        }), '{}');
        const parsed = JSON.parse(res.text);
        const data = parsed && parsed.data;
        if (!data || !data.accessToken || !data.refreshToken) {
          logTo(logFile, 'token refresh failed status=' + res.status);
          return auth;
        }
        auth = { accessToken: data.accessToken, refreshToken: data.refreshToken };
        persistAuth(auth, logFile);
        logTo(logFile, 'token refreshed');
        return auth;
      } catch (e) {
        logTo(logFile, 'token refresh error: ' + e.message);
        return auth;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  return { ensureAuth, getAuth: () => auth };
}

// ── request translation ────────────────────────────────────────────────

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') { parts.push(part); continue; }
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('');
}

function buildMessages(payload) {
  const messages = [];
  if (typeof payload.instructions === 'string' && payload.instructions.trim()) {
    messages.push({ role: 'system', content: payload.instructions });
  }
  const input = Array.isArray(payload.input) ? payload.input : [];
  for (const item of input) {
    if (!item) continue;
    const kind = item.type || (item.role ? 'message' : '');
    if (kind === 'message') {
      const role = item.role === 'developer' ? 'system' : (item.role || 'user');
      const text = contentToText(item.content);
      if (role === 'assistant' && !text) continue;
      messages.push({ role, content: text });
    } else if (kind === 'function_call' || kind === 'custom_tool_call') {
      let args = item.arguments;
      if (kind === 'custom_tool_call') args = JSON.stringify({ input: item.input == null ? '' : item.input });
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || 'call_0',
          type: 'function',
          function: { name: item.name || 'tool', arguments: args || '{}' },
        }],
      });
    } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
      const out = item.output != null ? item.output : item.content;
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || 'call_0',
        content: typeof out === 'string' ? out : JSON.stringify(out == null ? '' : out),
      });
    }
  }
  return messages;
}

function buildTools(payload) {
  const tools = [];
  for (const tool of payload.tools || []) {
    if (!tool) continue;
    if (tool.type === 'function' && tool.name) {
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} },
        },
      });
    } else if (tool.type === 'custom' && tool.name === 'exec') {
      tools.push({
        type: 'function',
        function: {
          name: 'exec',
          description: tool.description || 'Run JavaScript through the Codex exec tool.',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: 'Raw JavaScript source code.' } },
            required: ['input'],
            additionalProperties: false,
          },
        },
      });
    }
  }
  return tools;
}

function reasoningEffort(payload) {
  const effort = payload && payload.reasoning && payload.reasoning.effort;
  if (effort === 'minimal' || effort === 'low') return 'low';
  if (effort === 'high' || effort === 'xhigh' || effort === 'max' || effort === 'ultra') return 'high';
  return null;
}

// ── response translation ───────────────────────────────────────────────

function emptyResponseObject(id, model, instructions) {
  return {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress', background: false, completed_at: null,
    content_filters: null, error: null, incomplete_details: null,
    instructions: instructions || null, max_output_tokens: null, max_tool_calls: null,
    model, moderation: null, output: [], parallel_tool_calls: true,
    previous_response_id: null, prompt_cache_key: null, reasoning: { effort: null, summary: null },
    safety_identifier: null, service_tier: 'default', store: false,
    temperature: 1, text: { format: { type: 'text' }, verbosity: null },
    tool_choice: 'auto', tools: [], top_logprobs: 0, top_p: 1,
    truncation: 'disabled', usage: null, user: null, metadata: {},
  };
}

function makeId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function createStreamState(response, model) {
  const id = makeId('resp');
  const LF = String.fromCharCode(10);
  const state = {
    id, model, sequence: 0, outputIndex: 0, output: [],
    textItem: null, toolItems: new Map(), usage: null, finished: false,
    started: false, pending: [],
    response, send(event, data) {
      state.sequence += 1;
      if (data && typeof data === 'object' && data.sequence_number === undefined) data.sequence_number = state.sequence;
      const frame = 'event: ' + event + LF + 'data: ' + JSON.stringify(data) + LF + LF;
      // Nothing may reach the client until the upstream answered 200, otherwise
      // an upstream error can no longer be reported as a clean HTTP error.
      if (!state.started) { state.pending.push(frame); return; }
      response.write(frame);
    },
    begin() {
      if (state.started) return;
      state.started = true;
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      for (const frame of state.pending) response.write(frame);
      state.pending.length = 0;
    },
  };
  return state;
}

function handleChatChunk(state, chunk) {
  const choice = chunk && chunk.choices && chunk.choices[0];
  if (!choice) return;
  const delta = choice.delta || {};

  if (typeof delta.content === 'string' && delta.content.length > 0) {
    if (!state.textItem) {
      const item = { type: 'message', id: makeId('msg'), status: 'in_progress', role: 'assistant', content: [] };
      state.textItem = { item, outputIndex: state.outputIndex++, text: '' };
      state.send('response.output_item.added', { type: 'response.output_item.added', item, output_index: state.textItem.outputIndex });
      state.send('response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: state.textItem.outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    }
    state.textItem.text += delta.content;
    state.send('response.output_text.delta', { type: 'response.output_text.delta', item_id: state.textItem.item.id, output_index: state.textItem.outputIndex, content_index: 0, delta: delta.content });
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls) {
      const key = typeof call.index === 'number' ? call.index : 0;
      let entry = state.toolItems.get(key);
      if (!entry) {
        entry = { id: makeId('fc'), callId: call.id || makeId('call'), name: '', arguments: '', outputIndex: state.outputIndex++, added: false };
        state.toolItems.set(key, entry);
      }
      if (call.id) entry.callId = call.id;
      if (call.function && typeof call.function.name === 'string' && call.function.name) entry.name += call.function.name;
      if (!entry.added && entry.name) {
        entry.added = true;
        const isExec = entry.name === 'exec';
        entry.isExec = isExec;
        entry.item = isExec
          ? { type: 'custom_tool_call', id: entry.id, status: 'in_progress', call_id: entry.callId, name: entry.name, input: '' }
          : { type: 'function_call', id: entry.id, status: 'in_progress', call_id: entry.callId, name: entry.name, arguments: '' };
        state.send('response.output_item.added', { type: 'response.output_item.added', item: entry.item, output_index: entry.outputIndex });
      }
      const frag = call.function && call.function.arguments;
      if (typeof frag === 'string' && frag.length) {
        entry.arguments += frag;
        if (!entry.isExec) {
          state.send('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: entry.id, output_index: entry.outputIndex, delta: frag });
        }
      }
    }
  }

  if (chunk.usage) state.usage = chunk.usage;
}

function finalizeText(state) {
  if (!state.textItem) return;
  const item = state.textItem.item;
  state.send('response.output_text.done', { type: 'response.output_text.done', item_id: item.id, output_index: state.textItem.outputIndex, content_index: 0, text: state.textItem.text });
  const part = { type: 'output_text', text: state.textItem.text, annotations: [] };
  state.send('response.content_part.done', { type: 'response.content_part.done', item_id: item.id, output_index: state.textItem.outputIndex, content_index: 0, part });
  const done = { type: 'message', id: item.id, status: 'completed', role: 'assistant', content: [part] };
  state.send('response.output_item.done', { type: 'response.output_item.done', item: done, output_index: state.textItem.outputIndex });
  state.output.push(done);
}

function finalizeTools(state) {
  const entries = [...state.toolItems.values()].sort((a, b) => a.outputIndex - b.outputIndex);
  for (const entry of entries) {
    if (!entry.added) continue;
    if (entry.isExec) {
      let input = '';
      try { input = JSON.parse(entry.arguments || '{}').input || ''; } catch { input = entry.arguments || ''; }
      const done = { type: 'custom_tool_call', id: entry.id, status: 'completed', call_id: entry.callId, name: 'exec', input };
      state.send('response.output_item.done', { type: 'response.output_item.done', item: done, output_index: entry.outputIndex });
      state.output.push(done);
    } else {
      state.send('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: entry.id, output_index: entry.outputIndex, arguments: entry.arguments });
      const done = { type: 'function_call', id: entry.id, status: 'completed', call_id: entry.callId, name: entry.name, arguments: entry.arguments };
      state.send('response.output_item.done', { type: 'response.output_item.done', item: done, output_index: entry.outputIndex });
      state.output.push(done);
    }
  }
}

async function handleResponsesRequest(ctx) {
  const { payload, response, target, client, logFile } = ctx;
  const auth = await client.ensureAuth();
  if (!auth) {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'WorkBuddy channel is not configured (missing access token). Run Update-WorkBuddyToken.cmd.' } }));
    return;
  }

  const messages = buildMessages(payload);
  const tools = buildTools(payload);
  const upstreamBody = {
    model: target.upstreamModel,
    messages,
    stream: true,
  };
  if (tools.length) {
    upstreamBody.tools = tools;
    upstreamBody.tool_choice = 'auto';
  }
  const effort = reasoningEffort(payload);
  if (effort) upstreamBody.reasoning_effort = effort;

  const state = createStreamState(response, payload.model);
  const responseObject = emptyResponseObject(state.id, payload.model, payload.instructions);
  state.send('response.created', { type: 'response.created', response: responseObject });
  state.send('response.in_progress', { type: 'response.in_progress', response: responseObject });

  return new Promise(resolve => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };

    const req = https.request({
      host: HOST, path: CHAT_PATH, method: 'POST',
      headers: Object.assign(baseHeaders(auth), { 'Content-Length': Buffer.byteLength(JSON.stringify(upstreamBody)) }),
    }, res => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          logTo(logFile, 'workbuddy upstream status=' + res.statusCode + ' body=' + text.slice(0, 300));
          try {
            response.writeHead(res.statusCode || 502, { 'content-type': 'application/json' });
            response.end(text || JSON.stringify({ error: { message: 'WorkBuddy upstream error' } }));
          } catch {}
          finish();
        });
        return;
      }

      let buffer = '';
      // Upstream accepted the request: safe to start the SSE response now.
      state.begin();
      res.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf(String.fromCharCode(10) + String.fromCharCode(10))) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = block.split(String.fromCharCode(10)).find(l => l.indexOf('data:') === 0);
          if (!dataLine) continue;
          const raw = dataLine.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          let parsed;
          try { parsed = JSON.parse(raw); } catch { continue; }
          try { handleChatChunk(state, parsed); } catch (e) { logTo(logFile, 'chunk error: ' + e.message); }
        }
      });

      res.on('end', () => {
        try {
          finalizeText(state);
          finalizeTools(state);
          const usage = state.usage || {};
          if (state.output.length === 0 && !state.textItem && state.toolItems.size === 0) {
            // Upstream closed without producing anything usable; report a real
            // error instead of a truncated success that would hang the client.
            const message = 'WorkBuddy upstream returned an empty stream';
            logTo(logFile, message);
            responseObject.status = 'failed';
            responseObject.error = { code: 'empty_stream', message };
            state.send('response.failed', { type: 'response.failed', response: responseObject });
            response.end();
            finish();
            return;
          }
          responseObject.status = 'completed';
          responseObject.completed_at = Math.floor(Date.now() / 1000);
          responseObject.output = state.output;
          responseObject.usage = {
            input_tokens: usage.prompt_tokens || 0,
            output_tokens: usage.completion_tokens || 0,
            total_tokens: usage.total_tokens || 0,
            input_tokens_details: { cached_tokens: usage.prompt_cache_hit_tokens || 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          };
          state.send('response.completed', { type: 'response.completed', response: responseObject });
          response.end();
        } catch (e) {
          logTo(logFile, 'finalize error: ' + e.message);
          try { response.end(); } catch {}
        }
        finish();
      });

      res.on('error', e => {
        logTo(logFile, 'upstream stream error: ' + e.message);
        try {
          if (state.started) {
            responseObject.status = 'failed';
            responseObject.error = { code: 'upstream_stream_error', message: e.message };
            state.send('response.failed', { type: 'response.failed', response: responseObject });
            response.end();
          } else {
            response.writeHead(502, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'WorkBuddy upstream stream error: ' + e.message } }));
          }
        } catch {}
        finish();
      });
    });

    req.on('error', e => {
      logTo(logFile, 'upstream request error: ' + e.message);
      if (!response.headersSent) {
        try {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'WorkBuddy upstream unreachable: ' + e.message } }));
        } catch {}
      } else {
        try { response.destroy(); } catch {}
      }
      finish();
    });

    req.end(JSON.stringify(upstreamBody));
  });
}

function loadCatalog(file) {
  const map = new Map();
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return map; }
  for (const model of parsed.models || []) {
    const slug = String(model && model.slug || '');
    const upstream = model && model.router && model.router.upstream_model;
    if (!slug || !upstream) continue;
    map.set(slug, { upstreamModel: String(upstream) });
  }
  return map;
}

module.exports = { createWorkBuddyClient, handleResponsesRequest, loadCatalog, CHAT_PATH, HOST };

