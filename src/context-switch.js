'use strict';
const { StringDecoder } = require('node:string_decoder');
// No credentials or conversation text is persisted. Bounded in-process replay
// lets a known response move between providers without reusing a foreign ID.
const createContextBridge = ({ maxBytes = 32 * 1024 * 1024, maxEntries = 128 } = {}) => {
  const records = new Map(); let bytes = 0;
  const fullHistory = input => Array.isArray(input)
    && input.some(i => i?.role === 'user')
    && input.some(i => i?.role === 'assistant' || ['function_call','custom_tool_call'].includes(i?.type));
  const prepare = (payload, provider) => {
    if (!payload.previous_response_id) return payload;
    const old = records.get(payload.previous_response_id);
    // Official Codex keeps previous_response_id server-side. DeepSeek and
    // relays may accept the field but do not reliably retain the full thread,
    // so replay the bounded local history for every non-official provider.
    if (old?.provider === provider && provider === 'official') return payload;
    if (fullHistory(payload.input)) {
      const { previous_response_id, ...rest } = payload; return rest;
    }
    if (!old) {
      const id = String(payload.previous_response_id);
      const foreignId = provider !== 'official'
        || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
      if (!provider.startsWith('workbuddy:') && !foreignId) return payload;
      throw new Error('Cross-channel continuation history unavailable. Resend complete visible history; no context was discarded.');
    }
    const { previous_response_id, ...rest } = payload;
    return { ...rest, input: [...structuredClone(old.history), ...(Array.isArray(payload.input) ? payload.input : [{role:'user',content:payload.input??''}])] };
  };
  const remember = (id, provider, payload, output) => {
    if (!id || !Array.isArray(output)) return;
    let input = payload.input;
    if (!Array.isArray(input)) input = [{role:'user',content:input??''}];
    const parent = records.get(payload.previous_response_id);
    if (parent && !fullHistory(input)) input = [...parent.history, ...input];
    const history = structuredClone([...input, ...output]);
    const size = Buffer.byteLength(JSON.stringify(history));
    const previous = records.get(id); if(previous){bytes-=previous.size;records.delete(id);}
    if(size>maxBytes)return;
    records.set(id,{provider,history,size});bytes+=size;
    while(bytes>maxBytes||records.size>maxEntries){const key=records.keys().next().value;bytes-=records.get(key).size;records.delete(key);}
  };
  return { prepare, remember };
};
// Watch the client-facing response, after DSML/custom-call translation. Never
// alter chunks. Large/invalid events are skipped rather than buffered forever.
const observeResponse = (response, completed, maxBuffer = 8 * 1024 * 1024) => {
  let buffer=''; const decoder=new StringDecoder('utf8'); const originalWrite=response.write,originalEnd=response.end;
  const consume = chunk => {
    if(chunk==null)return;
    buffer+=Buffer.isBuffer(chunk)?decoder.write(chunk):String(chunk);
    if(buffer.length>maxBuffer){buffer='';return;}
    let separator;
    while((separator=/\r?\n\r?\n/.exec(buffer))){const at=separator.index;const block=buffer.slice(0,at);buffer=buffer.slice(at+separator[0].length);const raw=block.match(/^data:\s*(.+)$/m)?.[1];try{const data=JSON.parse(raw);if(data.type==='response.completed'&&data.response)completed(data.response);}catch{}}
  };
  response.write=function(chunk,...args){consume(chunk);return originalWrite.call(this,chunk,...args);};
  response.end=function(chunk,...args){consume(chunk);try{const data=JSON.parse(buffer);if(data.id&&Array.isArray(data.output))completed(data);}catch{}buffer='';return originalEnd.call(this,chunk,...args);};
};
module.exports={createContextBridge,observeResponse};
