const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
// DSML 是 DeepSeek 自己的工具调用方言。模型偶尔会把标记当普通文本输出，
// 而不是返回结构化的 function_call，因此这里统一在流式转发时把它还原成
// 真正的工具事件。解析规则和流式缓冲都在独立模块里，便于单独测试。
const dsml = require('./dsml.js');
const workbuddy = require('./workbuddy-adapter.js');
const { createContextBridge, observeResponse } = require('./context-switch.js');
const contextBridge = createContextBridge();

const deepseekKey = process.env.DEEPSEEK_API_KEY;
if (!deepseekKey) throw new Error('DEEPSEEK_API_KEY is missing');

const allowedDeepSeekModels = new Set(['deepseek-flash', 'deepseek-v4-pro']);
const maxRequestBytes = 64 * 1024 * 1024;
const deepSeekTimeoutMs = 300000;

const paths = require('./paths');
const routerLog = paths.routerLog;
const supervisorPid = process.ppid;
// The watchdog only needs to run for the real service; unref keeps a
// library require (tests) from being held open by its timer.
const supervisorWatch = setInterval(() => {
  try {
    process.kill(supervisorPid, 0);
  } catch {
    fs.appendFileSync(routerLog, `${new Date().toISOString()} supervisor ${supervisorPid} exited; stopping router\n`);
    process.exit(0);
  }
}, 2000);
supervisorWatch.unref();

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

// DSML calls are synthesized by this router after DeepSeek has already saved
// its response. Codex Desktop then continues with previous_response_id and
// only the tool output, so DeepSeek cannot find the synthetic call in its
// stored response. Keep a small in-memory bridge and replay that call on the
// continuation request.
const syntheticDeepSeekCalls = new Map();
const rememberSyntheticDeepSeekCalls = (responseId, calls) => {
  if (!responseId || !calls.length) return;
  syntheticDeepSeekCalls.set(responseId, calls.map(item => ({ ...item })));
  while (syntheticDeepSeekCalls.size > 128) {
    syntheticDeepSeekCalls.delete(syntheticDeepSeekCalls.keys().next().value);
  }
};

// DeepSeek 的思考模式要求：凡带 function_call 的助手回合，回放时都必须把
// 那一轮的 reasoning_text 一起交回去。Codex 只保留它自己收到过的东西，而
// DSML 合成出来的调用是路由器后补的，推理文本不会进入 Codex 的历史记录。
// 这里按上流事件里的 item id 缓存推理文本，回放时补回；确实没有缓存时补一
// 条描述本次工具动作的说明，保证请求结构合法。
const deepSeekReasoningByItem = new Map();

const rememberDeepSeekReasoning = (itemId, text) => {
  if (!itemId || typeof text !== 'string' || !text.trim()) return;
  deepSeekReasoningByItem.set(itemId, text);
  while (deepSeekReasoningByItem.size > 256) {
    deepSeekReasoningByItem.delete(deepSeekReasoningByItem.keys().next().value);
  }
};

const reasoningTextOf = item => {
  const collect = parts => (Array.isArray(parts) ? parts : [])
    .filter(part => typeof part?.text === 'string')
    .map(part => part.text)
    .join('');
  const fromContent = collect(item?.content);
  if (fromContent.trim()) return fromContent;
  return collect(item?.summary);
};

// DeepSeek reasoning items are not portable to OpenAI: their content contains
// reasoning_text and their encrypted_content is a DeepSeek response marker,
// not an OpenAI encrypted reasoning token. Keep ordinary messages and tool
// results, but omit those reasoning items when a conversation switches to GPT.
const foreignReasoningId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-\d+)?$/i;
const isForeignReasoning = item => item?.type === 'reasoning' && (
  foreignReasoningId.test(item.id ?? '')
  || foreignReasoningId.test(item.encrypted_content ?? '')
  || (Array.isArray(item.content) && item.content.length > 0)
);

const normalizeOpenAiInput = payload => {
  if (!Array.isArray(payload?.input)) return payload;
  // Item IDs belong to the originating backend. DeepSeek UUIDs (including
  // converted custom-tool items) are not valid OpenAI ctc_/msg_/fc_ IDs.
  // These IDs are optional in replay; call_id still links calls and outputs.
  let changed = false;
  const input = payload.input.filter(item => {
    if (!isForeignReasoning(item)) return true;
    changed = true;
    return false;
  }).map(item => {
    if (!item || typeof item !== 'object') return item;
    const id = String(item.id ?? '');
    if (!foreignReasoningId.test(id) && !/^(?:dsml-|router-)/.test(id)) return item;
    const { id: ignored, ...rest } = item;
    changed = true;
    return rest;
  });
  return changed ? { ...payload, input } : payload;
};

const normalizeRelayInput = payload => Array.isArray(payload?.input)
  ? { ...payload, input: payload.input.filter(item => item?.type !== 'reasoning') }
  : payload;

const stripDeepSeekEncryption = item => {
  if (item?.type !== 'reasoning' || !('encrypted_content' in item)) return item;
  const { encrypted_content, ...safeItem } = item;
  return safeItem;
};

const toDeepSeekFunctionCall = item => {
  const { input: source, ...rest } = item;
  return {
    ...rest,
    type: 'function_call',
    arguments: JSON.stringify({ input: source == null ? '' : String(source) }),
  };
};

// Codex keeps its free-form exec calls as custom_tool_call items in the
// conversation. DeepSeek's Responses endpoint expects the standard
// function_call/function_call_output shapes when those items are replayed on
// the next turn. Without this translation the first call may work, but the
// follow-up turn is often emitted as raw DSML text instead of a tool call.
const normalizeDeepSeekInput = payload => {
  if (!Array.isArray(payload?.input)) return payload;
  let input = payload.input.map(item => {
    if (item?.type === 'custom_tool_call') {
      return toDeepSeekFunctionCall(item);
    }
    if (item?.type === 'custom_tool_call_output') {
      const { ...rest } = item;
      return { ...rest, type: 'function_call_output' };
    }
    return item;
  });
  const remembered = syntheticDeepSeekCalls.get(payload.previous_response_id);
  if (remembered?.length) {
    const outputIds = new Set(input.filter(item => item?.type === 'function_call_output').map(item => item.call_id));
    const presentIds = new Set(input.filter(item => item?.type === 'function_call').map(item => item.call_id));
    const missingCalls = remembered
      .filter(item => outputIds.has(item.call_id) && !presentIds.has(item.call_id))
      .map(toDeepSeekFunctionCall);
    if (missingCalls.length) input = [...missingCalls, ...input];
  }
  // A restarted router cannot replay calls from the prior process. DeepSeek
  // rejects their function_call_output items with HTTP 400, which leaves the
  // Codex thread stuck on every retry. Present only those orphaned results as
  // ordinary context so the model can finish the pending turn.
  if (payload.previous_response_id) {
    const callIds = new Set(input.filter(item => item?.type === 'function_call').map(item => item.call_id));
    input = input.map(item => {
      if (item?.type !== 'function_call_output' || callIds.has(item.call_id)) return item;
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      return {
        role: 'user',
        content: [{ type: 'input_text', text: `The prior exec tool call (${item.call_id}) completed with this output:\n${output}\nContinue the pending task using this result.` }],
      };
    });
  }
  // Codex can place an assistant message between a replayed tool call and its
  // result. DeepSeek requires the matching result immediately after the call.
  for (let index = 0; index < input.length; index++) {
    const item = input[index];
    if (item?.type !== 'function_call') continue;
    const outputIndex = input.findIndex((candidate, position) =>
      position > index && candidate?.type === 'function_call_output' && candidate.call_id === item.call_id
    );
    if (outputIndex > index + 1) {
      const [output] = input.splice(outputIndex, 1);
      input.splice(index + 1, 0, output);
    }
  }

  // 思考模式：带 function_call 的回合必须携带 reasoning_text。
  const rebuilt = [];
  let coveredReasoning = '';
  for (const item of input) {
    if (item?.type === 'reasoning') {
      // Official opaque reasoning cannot be consumed by DeepSeek. Its summary
      // is not the original reasoning_text, so never pretend it is a replay.
      if (String(item.id ?? '').startsWith('rs_')) continue;
      const text = reasoningTextOf(item);
      if (text.trim()) {
        coveredReasoning = text;
        rebuilt.push(item);
        continue;
      }
      const cached = deepSeekReasoningByItem.get(item.id);
      if (cached) {
        coveredReasoning = cached;
        rebuilt.push({ ...item, content: [{ type: 'reasoning_text', text: cached }] });
      }
      continue;
    }
    if (item?.type === 'function_call' && !coveredReasoning) {
      const callName = item.name ? String(item.name) : '工具';
      const placeholder = `调用 ${callName} 以继续处理当前任务。`;
      rebuilt.push({
        type: 'reasoning',
        id: 'router-reasoning-' + String(item.call_id ?? rebuilt.length),
        summary: [],
        content: [{ type: 'reasoning_text', text: placeholder }],
      });
      coveredReasoning = placeholder;
    }
    rebuilt.push(item);
    // reasoning 只对「紧随其后的相邻工具调用」有效。一个回合以工具结果或
    // 用户消息收尾后，下一段工具调用必须重新携带 reasoning，否则 DeepSeek
    // 会以 reasoning_text ... must be passed back 拒绝整个请求。
    if (
      item?.type === 'function_call_output'
      || (item?.type === 'message' && item.role !== 'assistant')
    ) {
      coveredReasoning = '';
    }
  }
  // 最后一条是 function_call（还没有结果）时，同样要保证它带着 reasoning。
  if (input.length && rebuilt.length) {
    const last = rebuilt[rebuilt.length - 1];
    if (last?.type === 'function_call') {
      const prev = rebuilt[rebuilt.length - 2];
      const hasReasoning = prev?.type === 'reasoning' && reasoningTextOf(prev).trim();
      if (!hasReasoning) {
        rebuilt.splice(rebuilt.length - 1, 0, {
          type: 'reasoning',
          id: 'router-reasoning-tail-' + String(last.call_id ?? rebuilt.length),
          summary: [],
          content: [{ type: 'reasoning_text', text: '继续执行上一步工具动作。' }],
        });
      }
    }
  }
  input = rebuilt;
  return { ...payload, input };
};

// 非流式分支的兜底：从 message 文本里抽出 DSML 调用，替换成真正的工具事件。
const repairJsonOutput = output => {
  const kept = [];
  const found = [];
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) {
      kept.push(item);
      continue;
    }
    const text = item.content.map(part => part?.text ?? '').join('');
    if (!text.includes('<｜｜DSML｜｜')) {
      kept.push(item);
      continue;
    }
    const extractor = dsml.createDsmlExtractor();
    const extracted = extractor.push(text);
    for (const call of extracted.calls) {
      const id = `dsml-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      found.push({ type: 'custom_tool_call', id, status: 'completed', call_id: `call_${id}`, name: call.name, input: call.input });
    }
    const remaining = (extracted.text + extractor.flush().text).trim();
    if (remaining) {
      kept.push({ ...item, content: [{ type: 'output_text', text: remaining, annotations: [] }] });
    }
  }
  return [...kept, ...found];
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
  const dsmlExtractor = dsml.createDsmlExtractor();
  const syntheticCalls = [];
  const progressMessages = [];
  const replayCalls = new Map();
  let terminalSeen = false;
  let progressSent = false;

  const emit = (event, data) => {
    data.sequence_number = nextSequence++;
    downstream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // DeepSeek reports its visible process as reasoning_text. Codex does not
  // render that event for this model profile, so emit a short assistant
  // commentary item when a tool step starts. Keep the detailed reasoning in
  // its original events for replay; the progress item is intentionally brief.
  const emitProgress = text => {
    if (progressSent) return;
    progressSent = true;
    const id = `router-progress-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const outputIndex = nextOutputIndex++;
    const part = { type: 'output_text', text, annotations: [] };
    const item = { type: 'message', id, status: 'completed', role: 'assistant', content: [part], phase: 'commentary' };
    emit('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } });
    emit('response.content_part.added', { type: 'response.content_part.added', item_id: id, output_index: outputIndex, content_index: 0, part: { ...part, text: '' } });
    emit('response.output_text.delta', { type: 'response.output_text.delta', item_id: id, output_index: outputIndex, content_index: 0, delta: text });
    emit('response.output_text.done', { type: 'response.output_text.done', item_id: id, output_index: outputIndex, content_index: 0, text });
    emit('response.content_part.done', { type: 'response.content_part.done', item_id: id, output_index: outputIndex, content_index: 0, part });
    emit('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
    progressMessages.push(item);
  };

  const forward = block => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const rawData = block.match(/^data:\s*(.+)$/m)?.[1];
    if (!event || !rawData) {
      fs.appendFileSync(routerLog, `${new Date().toISOString()} deepseek ignored invalid SSE block ${JSON.stringify(block.slice(0, 240))}\n`);
      return;
    }
    let data;
    try { data = JSON.parse(rawData); } catch {
      fs.appendFileSync(routerLog, `${new Date().toISOString()} deepseek ignored invalid SSE JSON ${JSON.stringify(block.slice(0, 240))}\n`);
      return;
    }

    if (event === 'response.completed' || event === 'response.incomplete' || event === 'response.failed') {
      terminalSeen = true;
    }

    if (event === 'response.reasoning_text.done') {
      rememberDeepSeekReasoning(data.item_id, data.text);
      if (typeof data.text === 'string' && data.text.trim()) {
        emitProgress('我先核对当前状态，再继续处理。');
      }
    }
    if (event === 'response.output_item.done' && data.item?.type === 'reasoning') {
      rememberDeepSeekReasoning(data.item.id, reasoningTextOf(data.item));
    }

    if (event === 'response.output_text.delta' && typeof data.delta === 'string') {
      const extracted = dsmlExtractor.push(data.delta);
      if (extracted.calls.length) emitProgress('正在执行下一步工具操作。');
      for (const call of extracted.calls) {
        const id = `dsml-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const callId = `call_${id}`;
        const item = { type: 'custom_tool_call', id, status: 'completed', call_id: callId, name: call.name, input: call.input };
        syntheticCalls.push(item);
        replayCalls.set(callId, item);
        const index = nextOutputIndex++;
        emit('response.output_item.added', { type: 'response.output_item.added', item: { ...item, status: 'in_progress', input: '' }, output_index: index });
        emit('response.output_item.done', { type: 'response.output_item.done', item, output_index: index });
      }
      if (extracted.text) {
        data.delta = extracted.text;
      } else {
        return;
      }
    }

    if (event === 'response.output_item.added') {
      outputMap.set(data.output_index, nextOutputIndex++);
      if (data.item?.type === 'function_call' && data.item.name === 'exec') {
        emitProgress('正在执行下一步工具操作。');
        execCalls.add(data.output_index);
        data.item = convertExecCall(data.item);
      }
    }
    if (execCalls.has(data.output_index) && event.startsWith('response.function_call_arguments.')) return;
    if (data.output_index !== undefined) {
      const mapped = outputMap.get(data.output_index);
      if (mapped !== undefined) data.output_index = mapped;
    }
    if (data.item) {
      data.item = stripDeepSeekEncryption(convertExecCall(data.item));
      if (data.item.type === 'custom_tool_call' && data.item.name === 'exec' && data.item.call_id) {
        replayCalls.set(data.item.call_id, data.item);
      }
    }
    // 收尾事件里往往带着累积全文，DSML 可能只在其中出现一次，需要再扫一遍。
    if (Array.isArray(data.item?.content)) {
      data.item.content = data.item.content.filter(part => typeof part?.text !== 'string' || !part.text.includes('<｜｜DSML｜｜'));
    }
    if (typeof data.text === 'string' && data.text.includes('<｜｜DSML｜｜')) return;
    if (data.response?.output) {
      data.response.output = data.response.output
        .filter(item => !JSON.stringify(item).includes('<｜｜DSML｜｜'))
        .map(item => stripDeepSeekEncryption(convertExecCall(item)));
      for (const item of syntheticCalls) data.response.output.push(item);
      for (const item of progressMessages) data.response.output.push(item);
      for (const item of data.response.output) {
        if (item.type === 'custom_tool_call' && item.name === 'exec' && item.call_id) replayCalls.set(item.call_id, item);
      }
      rememberSyntheticDeepSeekCalls(data.response.id, [...replayCalls.values()]);
    }
    emit(event, data);
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
    const tail = dsmlExtractor.flush();
    if (tail.calls.length) {
      for (const call of tail.calls) {
        const id = `dsml-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const callId = `call_${id}`;
        const item = { type: 'custom_tool_call', id, status: 'completed', call_id: callId, name: call.name, input: call.input };
        syntheticCalls.push(item);
        replayCalls.set(callId, item);
        const index = nextOutputIndex++;
        emit('response.output_item.added', { type: 'response.output_item.added', item: { ...item, status: 'in_progress', input: '' }, output_index: index });
        emit('response.output_item.done', { type: 'response.output_item.done', item, output_index: index });
      }
    }
    if (tail.text) {
      emit('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'router-recovered-text', output_index: 0, content_index: 0, delta: tail.text });
    }
    if (!terminalSeen) {
      fs.appendFileSync(routerLog, `${new Date().toISOString()} deepseek stream ended without terminal event; emitted explicit incomplete response\n`);
      emit('response.incomplete', {
        type: 'response.incomplete',
        response: {
          id: `router-incomplete-${Date.now().toString(36)}`,
          object: 'response',
          status: 'incomplete',
          incomplete_details: { reason: 'stream_ended_without_terminal_event' },
          error: null,
          output: syntheticCalls,
        },
      });
    }
    downstream.end();
  });
  upstream.on('error', error => {
    fs.appendFileSync(routerLog, `${new Date().toISOString()} deepseek stream error ${JSON.stringify({ code: String(error?.code ?? 'STREAM_ERROR'), message: String(error?.message ?? 'stream failed').slice(0, 240) })}\n`);
    const tail = dsmlExtractor.flush();
    for (const call of tail.calls) {
      const id = `dsml-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const item = { type: 'custom_tool_call', id, status: 'completed', call_id: `call_${id}`, name: call.name, input: call.input };
      syntheticCalls.push(item);
      replayCalls.set(item.call_id, item);
      const outputIndex = nextOutputIndex++;
      emit('response.output_item.added', { type: 'response.output_item.added', item: { ...item, status: 'in_progress', input: '' }, output_index: outputIndex });
      emit('response.output_item.done', { type: 'response.output_item.done', item, output_index: outputIndex });
    }
    if (tail.text) emit('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'router-recovered-text', output_index: 0, content_index: 0, delta: tail.text });
    emit('response.failed', {
      type: 'response.failed',
      response: {
        id: `router-failed-${Date.now().toString(36)}`,
        object: 'response',
        status: 'failed',
        error: { code: String(error?.code ?? 'STREAM_ERROR'), message: 'DeepSeek upstream stream was interrupted' },
        output: syntheticCalls,
      },
    });
    downstream.end();
  });
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
    const result = Buffer.from(JSON.stringify({ status: 'ok', pid: process.pid, contextBridgeVersion: 1 }));
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
    const deepSeekRequestShape = () => JSON.stringify({
      model: slug,
      previous_response_id: payload?.previous_response_id ?? null,
      input: Array.isArray(payload?.input)
        ? payload.input.map(item => ({
            type: item?.type ?? 'message',
            role: item?.role ?? null,
            call_id: item?.call_id ?? null,
            name: item?.name ?? null,
          }))
        : typeof payload?.input,
      tools: Array.isArray(payload?.tools) ? payload.tools.length : null,
    });
    const workbuddyTarget = workbuddyCatalog.get(slug);
    const relayForContext = relayCatalog.models.get(slug);
    const provider = workbuddyTarget ? `workbuddy:${slug}` : relayForContext
      ? `relay:${relayForContext.provider.host}` : slug.startsWith('deepseek-') ? 'deepseek' : 'official';
    if (requestPath === '/responses') {
      try { payload = contextBridge.prepare(payload, provider); }
      catch (error) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: error.message, code: 'context_replay_required' } }));
        return;
      }
      const historyPayload = structuredClone(payload);
      observeResponse(response, result => contextBridge.remember(result.id, provider, historyPayload, result.output));
      body = Buffer.from(JSON.stringify(payload));
    }
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
    if (useDeepSeek) {
      payload = normalizeDeepSeekInput(payload);
      if (Array.isArray(payload.tools)) payload.tools = payload.tools.flatMap(tool => {
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
      // Encrypted reasoning is bound to its originating backend/account. Keep
      // visible messages and tool records; never forward opaque tokens to a relay.
      payload = normalizeRelayInput(payload);
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
    // The official GPT path and the relays speak OpenAI Responses, where a
    // reasoning item must carry an empty content array.
    if (!useDeepSeek) {
      payload = normalizeOpenAiInput(payload);
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
          if (upstreamStatus >= 400) {
            const chunks = [];
            upstreamResponse.on('data', chunk => chunks.push(chunk));
            upstreamResponse.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              fs.appendFileSync(routerLog, `${new Date().toISOString()} deepseek status=${upstreamStatus} error=${JSON.stringify(text.slice(0, 500))} request=${deepSeekRequestShape()}\n`);
              response.writeHead(upstreamStatus, { ...upstreamResponse.headers, 'content-length': Buffer.byteLength(text) });
              response.end(text);
            });
            return;
          }
          streamDeepSeek(upstreamResponse, response);
        } else if (useDeepSeek && contentType.includes('application/json')) {
        const responseChunks = [];
        upstreamResponse.on('data', chunk => responseChunks.push(chunk));
        upstreamResponse.on('end', () => {
          let result = Buffer.concat(responseChunks);
          try {
            const payload = JSON.parse(result.toString('utf8'));
            if (upstreamStatus >= 400) {
              const errorMessage = String(payload?.error?.message ?? '').slice(0, 400);
              fs.appendFileSync(routerLog, `${new Date().toISOString()} deepseek status=${upstreamStatus} error=${JSON.stringify(errorMessage)} request=${deepSeekRequestShape()}\n`);
            }
            if (Array.isArray(payload.output)) {
              payload.output = repairJsonOutput(payload.output)
                .map(item => stripDeepSeekEncryption(convertExecCall(item)));
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
      upstream.on('error', error => {
        if (retrying) return;
        if (response.headersSent) return;
        const detail = {
          code: String(error?.code ?? 'UPSTREAM_CONNECTION_ERROR'),
          message: String(error?.message ?? 'upstream connection failed').slice(0, 240),
          host: hostname,
          model: slug,
          provider: useDeepSeek ? 'deepseek' : (relayTarget ? 'relay' : 'codex'),
        };
        fs.appendFileSync(routerLog, `${new Date().toISOString()} upstream error ${JSON.stringify(detail)}\n`);
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Model connection failed', type: 'upstream_connection_error', code: detail.code } }));
      });
      // DeepSeek can hold a connection open without emitting any terminal
      // event. A bounded socket activity timeout surfaces that as a real
      // error, which the stream handler reports to Codex.
      if (useDeepSeek) upstream.setTimeout(deepSeekTimeoutMs, () => {
        upstream.destroy(new Error('DeepSeek upstream inactive for 300s'));
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
// 直接运行时才监听端口，被测试 require 时只导出内部函数。
if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log('codex model router listening on http://127.0.0.1:' + PORT);
  });
}

module.exports = { convertExecCall, streamDeepSeek, repairJsonOutput, normalizeDeepSeekInput, normalizeOpenAiInput, normalizeRelayInput };
