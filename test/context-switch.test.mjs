import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createContextBridge,observeResponse}=require('../src/context-switch.js');
const {buildMessages}=require('../src/workbuddy-adapter.js');
test('GPT to DeepSeek replays incremental tool output with original history',()=>{
 const b=createContextBridge();const user={role:'user',content:'project fact'};const call={type:'custom_tool_call',call_id:'c1',name:'exec',input:'text(1)'};
 b.remember('resp_one','official',{input:[user]},[call]);
 const out={type:'custom_tool_call_output',call_id:'c1',output:'tool fact'};const req={previous_response_id:'resp_one',input:[out]};
 assert.deepEqual(b.prepare(req,'deepseek'),{input:[user,call,out]});assert.equal(req.previous_response_id,'resp_one');
});
test('DeepSeek continuation replays local history instead of trusting remote state',()=>{
 const b=createContextBridge();b.remember('uuid','deepseek',{input:[{role:'user',content:'fact'}]},[{role:'assistant',content:'answer'}]);
 const req={previous_response_id:'uuid',input:[{role:'user',content:'continue'}]};
 const deepseek=b.prepare(req,'deepseek');assert.equal(deepseek.previous_response_id,undefined);assert.equal(deepseek.input.length,3);
 const gpt=b.prepare(req,'official');assert.equal(gpt.previous_response_id,undefined);assert.equal(gpt.input.length,3);
});
test('complete history removes stale response ID without duplication',()=>{
 const b=createContextBridge();const input=[{role:'user',content:'fact'},{role:'assistant',content:'answer'}];
 assert.deepEqual(b.prepare({previous_response_id:'unknown',input},'official'),{input});
});
test('WorkBuddy always replays known incremental history',()=>{
 const b=createContextBridge();b.remember('resp-wb','workbuddy:wb-flash',{input:[{role:'user',content:'fact'}]},[{role:'assistant',content:'answer'}]);
 assert.equal(b.prepare({previous_response_id:'resp-wb',input:[{role:'user',content:'next'}]},'workbuddy:wb-flash').input.length,3);
});
test('evicted/restarted known-foreign incremental history raises explicit error',()=>{
 const b=createContextBridge({maxEntries:1});b.remember('resp_old','official',{input:[]},[]);b.remember('resp_new','official',{input:[]},[]);
 assert.throws(()=>b.prepare({previous_response_id:'resp_old',input:[]},'deepseek'),/history unavailable/);
 assert.throws(()=>b.prepare({previous_response_id:'6e377903-5c4c-467a-be9d-e2bfa2da66d0',input:[]},'official'),/history unavailable/);
});
test('WorkBuddy orphan results are preserved as explicit completed context',()=>{
 const messages=buildMessages({input:[{type:'custom_tool_call_output',call_id:'prior',output:'IMPORTANT_RESULT'}]});
 assert.equal(messages.length,1);assert.ok(messages[0].content.includes('IMPORTANT_RESULT'));assert.ok(!messages.some(m=>m.role==='tool'));
});
test('client-facing observer handles split UTF-8 and CRLF events unchanged',()=>{
 const written=[];const r={write(c){written.push(c);return true},end(c){if(c)written.push(c)}};const seen=[];observeResponse(r,x=>seen.push(x));
 const data=Buffer.from('event: response.completed\r\ndata: '+JSON.stringify({type:'response.completed',response:{id:'a',output:[{text:'你好🚀'}]}})+'\r\n\r\n');
 for(const byte of data)r.write(Buffer.from([byte]));r.end();assert.equal(seen[0].output[0].text,'你好🚀');assert.deepEqual(Buffer.concat(written),data);
});
