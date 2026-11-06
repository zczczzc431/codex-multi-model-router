import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

// The router throws at import time without a key; the value is never used by
// the functions under test.
process.env.DEEPSEEK_API_KEY ||= 'test-key';

const router = require('../src/router.js');
const dsml = require('../src/dsml.js');

const BAR = '\uFF5C';
const D = `${BAR}${BAR}DSML${BAR}${BAR}`;

const dsmlBlock = (input, tool = 'exec') => [
  `<${D} calls>`,
  `<${D} invoke name="${tool}">`,
  `<${D} parameter name="input" string="true">`,
  input,
  `</${D} parameter>`,
  `</${D} invoke>`,
  `</${D} calls>`,
].join('\n');

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// Builds a fake upstream that streams `chunks` and records what came back.
function runStream(chunks) {
  const upstream = new EventEmitter();
  upstream.headers = { 'content-type': 'text/event-stream' };
  upstream.statusCode = 200;

  let written = '';
  const downstream = {
    writeHead() {},
    write(chunk) { written += chunk; },
    end() {},
    destroy() {},
  };

  router.streamDeepSeek(upstream, downstream);
  for (const chunk of chunks) upstream.emit('data', Buffer.from(chunk, 'utf8'));
  upstream.emit('end');

  const events = [];
  for (const block of written.split(/\n\n/)) {
    const name = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const raw = block.match(/^data:\s*(.+)$/m)?.[1];
    if (!name || !raw) continue;
    try { events.push({ name, data: JSON.parse(raw) }); } catch {}
  }
  return { written, events };
}

test('converts a DSML text reply into a real custom_tool_call', () => {
  const text = dsmlBlock('console.log(&#x22;hi&#x22;)');
  const source = sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: text })
    + sse('response.output_text.done', { type: 'response.output_text.done', item_id: 'm', output_index: 0, content_index: 0, text })
    + sse('response.completed', { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }] } });

  const { written, events } = runStream([source]);
  const done = events.filter(e => e.name === 'response.output_item.done').map(e => e.data.item);
  const calls = done.filter(i => i?.type === 'custom_tool_call');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'exec');
  assert.equal(calls[0].input, 'console.log("hi")');
  assert.ok(!written.includes('DSML'));
});

test('emits visible commentary before a DeepSeek tool call', () => {
  const text = dsmlBlock('console.log(6)');
  const source = sse('response.output_text.delta', {
    type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: text,
  }) + sse('response.completed', {
    type: 'response.completed', response: { id: 'progress-r', status: 'completed', output: [] },
  });
  const { events } = runStream([source]);
  const commentary = events
    .filter(event => event.name === 'response.output_item.done')
    .map(event => event.data.item)
    .find(item => item?.type === 'message' && item.role === 'assistant' && item.phase === 'commentary');
  assert.ok(commentary, 'a visible commentary item is required for progress');
  assert.match(commentary.content[0].text, /工具|执行|检查/);
});

test('reassembles a marker split across upstream chunks', () => {
  const text = dsmlBlock('console.log(1)');
  const whole = sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: text })
    + sse('response.output_text.done', { type: 'response.output_text.done', item_id: 'm', output_index: 0, content_index: 0, text })
    + sse('response.completed', { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }] } });

  // Network boundaries land in the middle of the marker.
  const chunks = [];
  for (let i = 0; i < whole.length; i += 17) chunks.push(whole.slice(i, i + 17));

  const { written, events } = runStream(chunks);
  const calls = events
    .filter(e => e.name === 'response.output_item.done')
    .map(e => e.data.item)
    .filter(i => i?.type === 'custom_tool_call');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'console.log(1)');
  assert.ok(!written.includes('DSML'));
});

test('keeps ordinary prose and drops only the markup', () => {
  const text = `好的，我来运行。\n${dsmlBlock('console.log(2)')}\n完成。`;
  const source = sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: text })
    + sse('response.completed', { type: 'response.completed', response: { id: 'r', status: 'completed', output: [] } });

  const { written } = runStream([source]);
  assert.ok(written.includes('好的，我来运行。'));
  assert.ok(!written.includes('DSML'));
});

test('flush removes an incomplete trailing marker from buffered prose', () => {
  const extractor = dsml.createDsmlExtractor();
  const complete = dsmlBlock('console.log(8)');
  extractor.push(`prefix ${complete}`);
  extractor.push(`\n${dsml.MARKER} incomplete`);
  const recovered = extractor.flush();
  assert.equal(recovered.calls.length, 0);
  assert.ok(!recovered.text.includes('DSML'));
});

test('upstream stream errors end with a response.failed event', () => {
  const upstream = new EventEmitter();
  upstream.headers = { 'content-type': 'text/event-stream' };
  upstream.statusCode = 200;
  let written = '';
  let ended = false;
  const downstream = {
    writeHead() {},
    write(chunk) { written += chunk; },
    end() { ended = true; },
    destroy() {},
  };
  router.streamDeepSeek(upstream, downstream);
  upstream.emit('error', Object.assign(new Error('peer reset'), { code: 'ECONNRESET' }));
  assert.equal(ended, true);
  assert.ok(written.includes('event: response.failed'));
  assert.ok(written.includes('interrupted'));
});

test('never turns a non-allowlisted tool into a call', () => {
  const text = dsmlBlock('rm -rf /', 'shell');
  const source = sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: text })
    + sse('response.completed', { type: 'response.completed', response: { id: 'r', status: 'completed', output: [] } });

  const { events } = runStream([source]);
  const calls = events
    .filter(e => e.name === 'response.output_item.done')
    .map(e => e.data.item)
    .filter(i => i?.type === 'custom_tool_call' || i?.type === 'function_call');

  assert.equal(calls.length, 0);
});

test('repairJsonOutput fixes a non-streaming reply', () => {
  const output = [
    { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: `前言\n${dsmlBlock('console.log(3)')}\n结尾` }] },
  ];
  const repaired = router.repairJsonOutput(output);
  const calls = repaired.filter(i => i.type === 'custom_tool_call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'console.log(3)');
  const message = repaired.find(i => i.type === 'message');
  assert.ok(message.content[0].text.includes('前言'));
  assert.ok(!message.content[0].text.includes('DSML'));
});

test('replays a synthetic DSML call for previous_response_id continuation', () => {
  const text = dsmlBlock('console.log(4)');
  const source = sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: text })
    + sse('response.completed', { type: 'response.completed', response: { id: 'stateful-r', status: 'completed', output: [] } });
  const { events } = runStream([source]);
  const call = events
    .filter(e => e.name === 'response.output_item.done')
    .map(e => e.data.item)
    .find(item => item?.type === 'custom_tool_call');

  const normalized = router.normalizeDeepSeekInput({
    previous_response_id: 'stateful-r',
    input: [{ type: 'custom_tool_call_output', call_id: call.call_id, output: '4' }],
  });

  // Thinking mode requires a reasoning item to directly precede each tool
  // call, so the router may prepend one when the cached text is unavailable.
  const callIndex = normalized.input.findIndex(item => item.type === 'function_call');
  assert.ok(callIndex > 0, 'a reasoning item must precede the tool call');
  assert.equal(normalized.input[callIndex - 1].type, 'reasoning');
  assert.equal(normalized.input[callIndex].call_id, call.call_id);
  assert.equal(normalized.input[callIndex + 1].type, 'function_call_output');
});

test('replays a native exec call for previous_response_id continuation', () => {
  const native = { type: 'function_call', id: 'fc', status: 'completed', call_id: 'call-native', name: 'exec', arguments: '{"input":"console.log(5)"}' };
  const source = sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: native })
    + sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: native })
    + sse('response.completed', { type: 'response.completed', response: { id: 'native-r', status: 'completed', output: [native] } });
  runStream([source]);

  const normalized = router.normalizeDeepSeekInput({
    previous_response_id: 'native-r',
    input: [{ type: 'custom_tool_call_output', call_id: 'call-native', output: '5' }],
  });

  const nativeIndex = normalized.input.findIndex(item => item.type === 'function_call');
  assert.ok(nativeIndex > 0, 'a reasoning item must precede the tool call');
  assert.equal(normalized.input[nativeIndex - 1].type, 'reasoning');
  assert.equal(normalized.input[nativeIndex].call_id, 'call-native');
  assert.equal(normalized.input[nativeIndex + 1].type, 'function_call_output');
});

test('recovers an orphaned tool result after router restart', () => {
  const normalized = router.normalizeDeepSeekInput({
    previous_response_id: 'response-from-prior-router-process',
    input: [{ type: 'custom_tool_call_output', call_id: 'call_dsml-old', output: '7' }],
  });
  assert.equal(normalized.input[0].role, 'user');
  assert.match(normalized.input[0].content[0].text, /call_dsml-old/);
  assert.match(normalized.input[0].content[0].text, /7/);
});

test('moves an interleaved assistant message after its tool result', () => {
  const normalized = router.normalizeDeepSeekInput({ input: [
    { type: 'custom_tool_call', call_id: 'call-interleaved', name: 'exec', input: 'console.log(7)' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Working on it.' }] },
    { type: 'custom_tool_call_output', call_id: 'call-interleaved', output: '7' },
  ] });
  const order = normalized.input.map(item => item.type ?? item.role);
  assert.ok(order.indexOf('function_call') < order.indexOf('function_call_output'));
  assert.ok(order.indexOf('function_call_output') < order.lastIndexOf('message'));
  assert.equal(order.filter(kind => kind === 'function_call').length, 1);
});

test('keeps DeepSeek reasoning text so Codex can replay it with tool output', () => {
  const reasoning = { type: 'reasoning', id: 'reason-1', encrypted_content: 'foreign-response-id-0', content: [{ type: 'reasoning_text', text: 'private reasoning token' }] };
  const call = { type: 'function_call', id: 'fc-1', call_id: 'call-reason', name: 'exec', arguments: '{"input":"console.log(7)"}' };
  const source = sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: reasoning })
    + sse('response.reasoning_text.delta', { type: 'response.reasoning_text.delta', output_index: 0, delta: 'private reasoning token' })
    + sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: reasoning })
    + sse('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: call })
    + sse('response.completed', { type: 'response.completed', response: { id: 'r-reason', status: 'completed', output: [reasoning, call] } });
  const { events } = runStream([source]);
  assert.ok(events.some(e => e.name === 'response.reasoning_text.delta'));
  assert.equal(events.find(e => e.name === 'response.completed').data.response.output[0].content[0].text, 'private reasoning token');
  for (const event of events) {
    if (event.data.item?.type === 'reasoning') assert.equal(event.data.item.encrypted_content, undefined);
    for (const item of event.data.response?.output ?? []) {
      if (item.type === 'reasoning') assert.equal(item.encrypted_content, undefined);
    }
  }
});
