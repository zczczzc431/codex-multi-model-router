const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const workbuddy = require('./workbuddy-adapter.js');

const deepseekKey = process.env.DEEPSEEK_API_KEY;
if (!deepseekKey) throw new Error('DEEPSEEK_API_KEY is missing');

const allowedDeepSeekModels = new Set(['deepseek-flash', 'deepseek-v4-pro']);
const maxRequestBytes = 64 * 1024 * 1024;

const paths = require('./paths');
const routerLog = paths.routerLog;
const supervisorPid = process.ppid;
setInterval(() => {
  try {
    process.kill(supervisorPid, 0);
  } catch {
    fs.appendFileSync(routerLog, `${new Date().toISOString()} supervisor ${supervisorPid} exited; stopping router\n`);
    process.exit(0);
  }
}, 2000);

// Relay providers are described by relay-models.json so new endpoints can be
// added without touching this file. Each entry maps a catalog slug to an
// upstream model name on a third-party OpenAI-compatible relay.
const relayCatalog = (() => {
  const empty = { models: new Map() };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.relayConfig, 'utf8'));
  } catch (error) {
    fs.appendFileSync(routerLog, `${new Date().toISOString()} relay catalog unavailable: ${error.message}\n`);
    return empty;
  }
  const providers = parsed.providers ?? {};
  const models = new Map();
  for (const model of parsed.models ?? []) {
    const slug = String(model?.slug ?? '');
    const provider = providers[model?.router?.provider];
    const upstreamModel = String(model?.router?.upstream_model ?? '');
    if (!slug || !provider || !upstreamModel) continue;
    const key = process.env[provider.apiKeyEnv] ?? '';
    models.set(slug, { provider, upstreamModel, key });
  }
  return { models };
})();

// WorkBuddy (Tencent CodeBuddy) models. These slugs are served by translating
// the Responses API into the streaming chat/completions API of the CodeBuddy
// gateway, so they can be picked from the Codex model menu like any other model.
const workbuddyCatalog = workbuddy.loadCatalog(paths.workbuddyConfig);
const workbuddyClient = workbuddy.createWorkBuddyClient({ logFile: routerLog });

const convertExecCall = item => {
  if (item?.type !== 'function_call' || item.name !== 'exec') return item;
  let input = '';
  try { input = JSON.parse(item.arguments ?? '{}').input ?? ''; } catch {}
  const { arguments: unused, ...rest } = item;
  return { ...rest, type: 'custom_tool_call', input };
};

const streamDeepSeek = (upstream, downstream) => {
  const headers = { ...upstream.headers };
  delete headers['content-length'];
  delete headers['transfer-encoding'];
  delete headers['content-encoding'];
  downstream.writeHead(upstream.statusCode ?? 502, headers);

  const outputMap = new Map();
  const execCalls = new Set();
  let nextOutputIndex = 0;
  let nextSequence = 0;
  let pending = '';

  const forward = block => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const rawData = block.match(/^data:\s*(.+)$/m)?.[1];
    if (!event || !rawData) return;
    let data;
    try { data = JSON.parse(rawData); } catch { downstream.write(`${block}\n\n`); return; }

    if (event.startsWith('response.reasoning_text.')) return;
    if (event === 'response.output_item.added') {
      if (data.item?.type === 'reasoning') {
        outputMap.set(data.output_index, null);
        return;
      }
      outputMap.set(data.output_index, nextOutputIndex++);
      if (data.item?.type === 'function_call' && data.item.name === 'exec') {
        execCalls.add(data.output_index);
        data.item = convertExecCall(data.item);
      }
    }
    if (execCalls.has(data.output_index) && event.startsWith('response.function_call_arguments.')) return;
    if (data.output_index !== undefined) {
      const mapped = outputMap.get(data.output_index);
      if (mapped === null) return;
      if (mapped !== undefined) data.output_index = mapped;
    }
    if (data.item?.type === 'reasoning' || data.part?.type === 'reasoning_text') return;
    if (data.item) data.item = convertExecCall(data.item);
    if (data.response?.output) {
      data.response.output = data.response.output.filter(item => item.type !== 'reasoning').map(convertExecCall);
    }
    data.sequence_number = nextSequence++;
    downstream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  upstream.on('data', chunk => {
    pending += chunk.toString('utf8').replaceAll('\r\n', '\n');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      forward(pending.slice(0, boundary));
      pending = pending.slice(boundary + 2);
    }
  });
  upstream.on('end', () => {
    if (pending.trim()) forward(pending);
    downstream.end();
  });
  upstream.on('error', () => downstream.destroy());
};

const maxGptBufferBytes = 512 * 1024;
const gptCommitSignals = [
  'response.output_item.added',
  'response.output_item.done',
  'response.output_text.delta',
  'response.reasoning_summary_text.delta',
  'response.reasoning_text.delta',
  'response.completed',
  'response.incomplete',
];

const makeBufferedRetryStream = overloadMarkers => (upstream, downstream, retry) => {
  const headers = { ...upstream.headers };
  delete headers['content-length'];
  delete headers['transfer-encoding'];

  const buffered = [];
  let bufferedBytes = 0;
  let committed = false;
  let abandoned = false;

  const commit = () => {
    if (committed || abandoned) return;
    committed = true;
    clearTimeout(commitTimer);
    downstream.writeHead(upstream.statusCode ?? 502, headers);
    for (const chunk of buffered) downstream.write(chunk);
    buffered.length = 0;
    upstream.pipe(downstream);
  };

  const commitTimer = setTimeout(commit, 20000);

  upstream.on('data', chunk => {
    if (committed || abandoned) return;
    buffered.push(chunk);
    bufferedBytes += chunk.length;
    const text = Buffer.concat(buffered).toString('utf8');
    if (overloadMarkers.some(marker => text.includes(marker))) {
      if (retry()) {
        abandoned = true;
        clearTimeout(commitTimer);
        buffered.length = 0;
        upstream.destroy();
        return;
      }
      commit();
      return;
    }
    if (bufferedBytes >= maxGptBufferBytes || gptCommitSignals.some(signal => text.includes(signal))) {
      commit();
    }
  });
  upstream.on('end', () => {
    if (abandoned) return;
    commit();
    downstream.end();
  });
  upstream.on('error', () => {
    if (abandoned) return;
    if (!committed) {
      clearTimeout(commitTimer);
      if (!downstream.headersSent) downstream.writeHead(502);
      downstream.end();
    } else {
      downstream.destroy();
    }
  });
};

// GPT keeps its original marker so behaviour is unchanged.
const streamGptWithRetry = makeBufferedRetryStream(['server_is_overloaded']);
// Third-party relays fail with their own wording before any content is sent.
const streamRelayWithRetry = makeBufferedRetryStream(['api relay request failed', 'event: error']);

const server = http.createServer((request, response) => {
  if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
    response.writeHead(403).end();
    return;
  }

  if (request.method === 'GET' && request.url === '/health') {
    const result = Buffer.from(JSON.stringify({ status: 'ok', pid: process.pid }));
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': result.length,
      'cache-control': 'no-store',
    });
    response.end(result);
    return;
  }

  const requestPath = new URL(request.url, 'http://127.0.0.1').pathname;
  if (request.method !== 'POST' || !['/responses', '/responses/compact'].includes(requestPath)) {
    response.writeHead(404).end();
    return;
  }

  const authorization = request.headers.authorization ?? '';
  if (!authorization.startsWith('Bearer ')) {
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Unauthorized local model-router request');
    return;
  }

  const chunks = [];
  let requestBytes = 0;
  let rejected = false;
  request.on('data', chunk => {
    if (rejected) return;
    requestBytes += chunk.length;
    if (requestBytes > maxRequestBytes) {
      rejected = true;
      response.writeHead(413).end('Request body too large');
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (rejected) return;
    let body = Buffer.concat(chunks);
    let model = '';
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
      model = payload.model ?? '';
      if (process.env.CODEX_ROUTER_DEBUG_TOOLS) {
        const tools = (payload.tools ?? []).map(tool => ({ type: tool.type, name: tool.name }));
        fs.appendFileSync(process.env.CODEX_ROUTER_DEBUG_TOOLS, `${JSON.stringify({ model, tools })}\n`);
      }
    } catch {
      response.writeHead(400).end('Invalid JSON request');
      return;
    }
    // Off by default. Set CODEX_ROUTER_DUMP_BODY to a file path when a provider
    // rejects a request and the exact payload has to be inspected.
    if (process.env.CODEX_ROUTER_DUMP_BODY || fs.existsSync(paths.routerDumpFlag)) {
      fs.appendFileSync(
        process.env.CODEX_ROUTER_DUMP_BODY || paths.routerDumpFile,
        `${JSON.stringify({ model, requestPath, body: body.toString('utf8') })}\n`
      );
    }
    const slug = String(model);
    const workbuddyTarget = workbuddyCatalog.get(slug);
    if (workbuddyTarget) {
      if (requestPath !== '/responses') {
        // The CodeBuddy gateway has no remote compaction endpoint, so answer
        // plainly and let Codex fall back to its local compaction path.
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"error":{"message":"workbuddy channel does not support remote compaction"}}');
        return;
      }
      workbuddy
        .handleResponsesRequest({ payload, response, target: workbuddyTarget, client: workbuddyClient, logFile: routerLog })
        .catch(error => {
          fs.appendFileSync(routerLog, new Date().toISOString() + ' workbuddy handler failed: ' + error.message + String.fromCharCode(10));
          try {
            if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'workbuddy handler failed: ' + error.message } }));
          } catch {}
        });
      return;
    }
    const useDeepSeek = slug.startsWith('deepseek-');
    const relayTarget = relayCatalog.models.get(slug);
    if (useDeepSeek && !allowedDeepSeekModels.has(slug)) {
      response.writeHead(400).end('Unsupported DeepSeek model');
      return;
    }
    if (slug.startsWith('relay-') && !relayTarget) {
      response.writeHead(400).end('Unsupported relay model');
      return;
    }
    if (relayTarget && !relayTarget.key) {
      response.writeHead(503).end(`Relay API key missing (${relayTarget.provider.apiKeyEnv ?? 'unknown'})`);
      return;
    }
    if (relayTarget && requestPath === '/responses/compact') {
      // Third-party relays expose no remote compaction endpoint; answer with a
      // plain error so Codex falls back to its local compaction path.
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"relay does not support remote compaction"}}');
      return;
    }
    if (useDeepSeek && payload?.tools) {
      payload.tools = payload.tools.flatMap(tool => {
        if (tool.type === 'function') return [tool];
        if (tool.type === 'custom' && tool.name === 'exec') {
          return [{
            type: 'function',
            name: 'exec',
            description: tool.description ?? 'Run JavaScript through the Codex exec tool.',
            parameters: {
              type: 'object',
              properties: { input: { type: 'string', description: 'Raw JavaScript source code.' } },
              required: ['input'],
              additionalProperties: false,
            },
          }];
        }
        return [];
      });
      body = Buffer.from(JSON.stringify(payload));
    }
    if (relayTarget) {
      // Relays expose the upstream model name and reject reasoning.summary and
      // the minimal/max/ultra effort values that Codex may send.
      payload.model = relayTarget.upstreamModel;
      const reasoning = payload.reasoning;
      if (reasoning && typeof reasoning === 'object') {
        delete reasoning.summary;
        if (reasoning.effort === 'minimal') reasoning.effort = 'low';
        else if (reasoning.effort === 'max' || reasoning.effort === 'ultra') reasoning.effort = 'xhigh';
        if (!reasoning.effort) delete reasoning.effort;
        if (Object.keys(reasoning).length === 0) delete payload.reasoning;
      }
      // Relay backends disagree on verbosity: the codex-family upstreams only
      // accept the default, so let them choose instead of forwarding it.
      if (payload.text && typeof payload.text === 'object') {
        delete payload.text.verbosity;
        if (Object.keys(payload.text).length === 0) delete payload.text;
      }
      body = Buffer.from(JSON.stringify(payload));
    }
    const hostname = relayTarget
      ? relayTarget.provider.host
      : useDeepSeek
        ? 'api.deepseek.com'
        : 'chatgpt.com';
    const path = relayTarget
      ? relayTarget.provider.path
      : useDeepSeek
        ? request.url
        : `/backend-api/codex${request.url}`;

    const headers = relayTarget
      ? {
          host: relayTarget.provider.host,
          authorization:
            relayTarget.provider.authorization === 'raw' ? relayTarget.key : `Bearer ${relayTarget.key}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'accept-encoding': 'identity',
          'content-length': body.length,
        }
      : useDeepSeek
        ? {
            host: hostname,
            authorization: `Bearer ${deepseekKey}`,
            'content-type': request.headers['content-type'] ?? 'application/json',
            accept: request.headers.accept ?? '*/*',
            'accept-encoding': 'identity',
            'content-length': body.length,
          }
        : { ...request.headers, host: hostname, 'content-length': body.length };
    delete headers.connection;
    delete headers['transfer-encoding'];
    delete headers['x-codex-router-token'];

    let gptAttempt = 0;
    const maxGptAttempts = 3;

    const issueUpstream = () => {
      gptAttempt += 1;
      let retrying = false;
      const retryUpstream = label => {
        if (gptAttempt >= maxGptAttempts) return false;
        retrying = true;
        fs.appendFileSync(
          routerLog,
          `${new Date().toISOString()} ${label} on attempt ${gptAttempt} for ${slug}; retrying\n`
        );
        setTimeout(issueUpstream, 600 * gptAttempt);
        return true;
      };
      const upstream = https.request({ hostname, path, method: request.method, headers }, upstreamResponse => {
        const contentType = upstreamResponse.headers['content-type'] ?? '';
        const upstreamStatus = upstreamResponse.statusCode ?? 502;
        if (relayTarget && (upstreamStatus >= 400 || contentType.includes('application/json'))) {
          const responseChunks = [];
          upstreamResponse.on('data', chunk => responseChunks.push(chunk));
          upstreamResponse.on('end', () => {
            const text = Buffer.concat(responseChunks).toString('utf8');
            const retryable =
              upstreamStatus >= 500 || upstreamStatus === 429 || text.includes('api relay request failed');
            if (retryable && retryUpstream('relay upstream failed')) return;
            const result = Buffer.from(text || `{"error":{"message":"relay status ${upstreamStatus}"}}`);
            response.writeHead(upstreamStatus, {
              'content-type': 'application/json',
              'content-length': result.length,
            });
            response.end(result);
          });
        } else if (relayTarget) {
          streamRelayWithRetry(upstreamResponse, response, () => retryUpstream('relay stream error'));
        } else if (useDeepSeek && contentType.includes('text/event-stream')) {
          streamDeepSeek(upstreamResponse, response);
        } else if (useDeepSeek && contentType.includes('application/json')) {
        const responseChunks = [];
        upstreamResponse.on('data', chunk => responseChunks.push(chunk));
        upstreamResponse.on('end', () => {
          let result = Buffer.concat(responseChunks);
          try {
            const payload = JSON.parse(result.toString('utf8'));
            if (Array.isArray(payload.output)) {
              payload.output = payload.output.filter(item => item.type !== 'reasoning').map(convertExecCall);
              result = Buffer.from(JSON.stringify(payload));
            }
          } catch {}
          const responseHeaders = { ...upstreamResponse.headers, 'content-length': result.length };
          delete responseHeaders['transfer-encoding'];
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          response.end(result);
        });
        } else if (!useDeepSeek && !contentType.includes('application/json')) {
          streamGptWithRetry(upstreamResponse, response, () => retryUpstream('upstream overloaded'));
        } else {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        }
      });
      upstream.on('error', () => {
        if (retrying) return;
        if (!response.headersSent) response.writeHead(502);
        response.end('Model connection failed');
      });
      upstream.end(body);
    };
    issueUpstream();
  });
});

server.on('error', error => {
  fs.appendFileSync(routerLog, `${new Date().toISOString()} router server error: ${error.message}\n`);
  process.exit(1);
});

const PORT = Number(process.env.CODEX_ROUTER_PORT) || 18763;
server.listen(PORT, '127.0.0.1', () => {
  console.log('codex model router listening on http://127.0.0.1:' + PORT);
});
