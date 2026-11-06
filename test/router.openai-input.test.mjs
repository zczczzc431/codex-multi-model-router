import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.DEEPSEEK_API_KEY ||= 'test-key';
const router = require('../src/router.js');

test('cross-provider replay drops foreign item IDs but preserves call links and text', () => {
  const payload={input:[
    {type:'custom_tool_call',id:'3b27d649-b965-4889-b2d7-68f8b750b8f5',call_id:'shared-call',name:'exec',input:'text(1)'},
    {type:'custom_tool_call_output',id:'router-output-1',call_id:'shared-call',output:'1'},
    {type:'message',id:'router-progress-1',role:'assistant',content:[{type:'output_text',text:'progress'}]},
    {type:'custom_tool_call',id:'ctc_official',call_id:'official-call',name:'exec',input:'text(2)'},
  ]};
  const out=router.normalizeOpenAiInput(payload);
  for(let i=0;i<3;i++){assert.equal(out.input[i].id,undefined);const {id,...rest}=payload.input[i];assert.deepEqual(out.input[i],rest);}
  assert.equal(out.input[3],payload.input[3]);
  assert.equal(payload.input[0].id,'3b27d649-b965-4889-b2d7-68f8b750b8f5');
});

test('relay removes opaque reasoning while preserving visible messages and tools', () => {
  const payload = {input:[{type:'reasoning',id:'rs_abc',encrypted_content:'opaque',content:[]},{role:'user',content:'fact'},{type:'function_call_output',call_id:'c1',output:'result'}]};
  assert.deepEqual(router.normalizeRelayInput(payload).input,payload.input.slice(1));
  assert.equal(payload.input.length,3);
});

test('DeepSeek never substitutes an official summary for original reasoning', () => {
  const out=router.normalizeDeepSeekInput({input:[{type:'reasoning',id:'rs_official',encrypted_content:'opaque',summary:[{text:'summary only'}],content:[]},{role:'user',content:'fact'}]});
  assert.equal(out.input.some(i=>i.encrypted_content),false);
  assert.equal(out.input.some(i=>i.id==='rs_official'),false);
});

test('drops historical DeepSeek reasoning while keeping the surrounding conversation', () => {
  const payload = {
    model: 'gpt-5.6-sol',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      {
        type: 'reasoning',
        id: '6e377903-5c4c-467a-be9d-e2bfa2da66d0',
        encrypted_content: '1e84a7a1-8fad-4e8f-881a-acfcf068e0ac-0',
        content: [{ type: 'reasoning_text', text: 'DeepSeek thoughts' }],
      },
      { type: 'function_call', call_id: 'c1', name: 'exec', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'done' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
    ],
  };
  const normalized = router.normalizeOpenAiInput(payload);
  assert.deepEqual(normalized.input, [payload.input[0], ...payload.input.slice(2)]);
});

test('preserves official encrypted reasoning items', () => {
  const payload = {
    model: 'gpt-5.6-sol',
    input: [{ type: 'reasoning', id: 'rs_abc123', encrypted_content: 'opaque-official-token', content: [], summary: [] }],
  };
  assert.equal(router.normalizeOpenAiInput(payload), payload);
});

test('drops foreign reasoning_text even without a vendor encryption marker', () => {
  const payload = {
    model: 'gpt-5.6-sol',
    input: [{ type: 'reasoning', id: 'r1', content: [{ type: 'reasoning_text', text: 'thinking' }] }],
  };
  assert.deepEqual(router.normalizeOpenAiInput(payload).input, []);
});

test('leaves ordinary OpenAI input untouched', () => {
  const payload = {
    model: 'gpt-5.6-sol',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  };
  assert.equal(router.normalizeOpenAiInput(payload), payload);
});

test('switching GPT to DeepSeek to GPT does not alter the shared history', () => {
  const payload = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      { type: 'reasoning', id: 'rs_official', encrypted_content: 'opaque-official-token', content: [] },
      { type: 'reasoning', id: '6e377903-5c4c-467a-be9d-e2bfa2da66d0', encrypted_content: '1e84a7a1-8fad-4e8f-881a-acfcf068e0ac-0', content: [{ type: 'reasoning_text', text: 'DeepSeek thoughts' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Visible answer' }] },
    ],
  };
  const original = structuredClone(payload);
  router.normalizeDeepSeekInput(payload);
  const openAi = router.normalizeOpenAiInput(payload);
  assert.deepEqual(payload, original);
  assert.deepEqual(openAi.input.map(item => item.id ?? item.role), ['user', 'rs_official', 'assistant']);
});

