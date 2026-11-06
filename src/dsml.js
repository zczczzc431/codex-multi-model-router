'use strict';

// DeepSeek's own function-calling dialect. When a request reaches the model in
// a shape it does not fully support, DeepSeek answers with this markup as
// ordinary text instead of a structured tool call:
//
//   <DSML marks>calls>
//   <DSML marks>invoke name="exec">
//   <DSML marks>parameter name="input" string="true">
//   ...javascript...
//   </DSML marks>parameter>
//   </DSML marks>invoke>
//   </DSML marks>calls>
//
// The literal marker uses U+FF5C FULLWIDTH VERTICAL LINE, spelled as "DSML"
// below with that character built from a codepoint so the file stays portable.
// Codex cannot act on that text, so it must be turned back into a real tool
// call before it reaches the client.

const BAR = '\uFF5C';
const D = `${BAR}${BAR}DSML${BAR}${BAR}`;

const MARKER = `<${D}`;
const OPEN_CALLS = `<${D} calls>`;
const CLOSE_CALLS = `</${D} calls>`;
const OPEN_INVOKE = `<${D} invoke name="`;
const OPEN_PARAMETER = `<${D} parameter name="`;
const CLOSE_PARAMETER = `</${D} parameter>`;

// Only these names may ever become an executable tool call. Anything else in
// the markup stays inert text instead of silently running.
const ALLOWED_TOOLS = new Set(['exec']);

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00A0'],
]);

function decodeDsmlEntities(value) {
  return String(value).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES.get(body);
    return named === undefined ? whole : named;
  });
}

function extractAttribute(openTag, attribute) {
  const match = openTag.match(new RegExp(`${attribute}\\s*=\\s*"([^"]*)"`));
  return match ? match[1] : null;
}

// Parses a complete DSML block. Returns null when the block is absent, still
// incomplete, or describes a tool this module refuses to run.
function parseDsmlCall(text) {
  const source = String(text ?? '');
  if (!source.includes(OPEN_CALLS) || !source.includes(CLOSE_CALLS)) return null;

  const callsStart = source.indexOf(OPEN_CALLS);
  const invokeStart = source.indexOf(OPEN_INVOKE, callsStart);
  if (invokeStart < 0) return null;
  const invokeOpenEnd = source.indexOf('>', invokeStart);
  if (invokeOpenEnd < 0) return null;
  const name = extractAttribute(source.slice(invokeStart, invokeOpenEnd + 1), 'name');
  if (!name || !ALLOWED_TOOLS.has(name)) return null;

  const parameterStart = source.indexOf(OPEN_PARAMETER, invokeOpenEnd);
  if (parameterStart < 0) return null;
  const parameterOpenEnd = source.indexOf('>', parameterStart);
  if (parameterOpenEnd < 0) return null;
  const parameterName = extractAttribute(source.slice(parameterStart, parameterOpenEnd + 1), 'name');
  if (parameterName !== 'input') return null;

  const parameterEnd = source.indexOf(CLOSE_PARAMETER, parameterOpenEnd);
  if (parameterEnd < 0) return null;

  const callsEnd = source.indexOf(CLOSE_CALLS, parameterEnd);
  if (callsEnd < 0) return null;

  return {
    name,
    // DSML 会把代码放在独立的一行，因此按行包裹时首尾会各带一个换行；
    // 这类空白不属于用户代码，去掉后才能原样交给 exec 工具。
    input: decodeDsmlEntities(source.slice(parameterOpenEnd + 1, parameterEnd)).replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, ''),
    start: callsStart,
    end: callsEnd + CLOSE_CALLS.length,
  };
}

// Streaming state machine. Deltas are buffered because the marker is routinely
// split across chunks; a call is emitted only once the whole block arrived.
// `filter` returns the plain text that is safe to forward plus any calls found,
// so a caller never has to reason about partial markers itself.
function createDsmlExtractor() {
  let buffer = '';
  const recoveryLimit = 512 * 1024;

  // Length of the longest suffix of `value` that is a prefix of `marker`.
  const partialMarkerLength = (value, marker) => {
    const max = Math.min(value.length, marker.length - 1);
    for (let size = max; size > 0; size -= 1) {
      if (value.endsWith(marker.slice(0, size))) return size;
    }
    return 0;
  };

  return {
    push(delta) {
      const chunk = String(delta ?? '');
      if (!chunk) return { text: '', calls: [] };

      buffer += chunk;
      const calls = [];
      let text = '';
      let cursor = 0;

      while (cursor < buffer.length) {
        const start = buffer.indexOf(MARKER, cursor);
        if (start < 0) {
          const tail = partialMarkerLength(buffer.slice(cursor), MARKER);
          text += buffer.slice(cursor, buffer.length - tail);
          cursor = buffer.length - tail;
          break;
        }

        text += buffer.slice(cursor, start);
        const call = parseDsmlCall(buffer.slice(start));
        if (!call) {
          // Either the block is still incomplete or it is markup this module
          // refuses to run. Keep it buffered so nothing is emitted prematurely.
          cursor = start;
          break;
        }

        calls.push({ name: call.name, input: call.input });
        cursor = start + call.end;
      }

      buffer = buffer.slice(cursor);
      return { text, calls };
    },

    // Flush a complete call or safe prose when the stream ends. Previously a
    // trailing partial block could remain buffered forever and be dropped.
    flush() {
      return this.recover();
    },

    // Recovery is used only when upstream ended without flushing .flush().
    // Keep either a completed call or ordinary prose; never return an
    // incomplete or non-allowlisted markup fragment as model output.
    recover() {
      if (!buffer) return { text: '', calls: [] };
      const raw = buffer;
      buffer = '';
      const calls = [];
      let cursor = 0;
      let text = '';
      const safeText = value => value
        .replaceAll(MARKER, '')
        .replace(/<\/?[^>]*DSML[^>]*>/gi, '')
        .slice(0, recoveryLimit);
      while (cursor < raw.length) {
        const start = raw.indexOf(MARKER, cursor);
        if (start < 0) {
          text += raw.slice(cursor);
          break;
        }
        text += raw.slice(cursor, start);
        const call = parseDsmlCall(raw.slice(start));
        if (call) {
          if (calls.length < 16) calls.push({ name: call.name, input: call.input });
          cursor = start + call.end;
          continue;
        }
        text += raw.slice(start, Math.min(raw.length, start + MARKER.length));
        cursor = start + MARKER.length;
      }
      return { text: safeText(text), calls };
    },

    reset() {
      buffer = '';
    },
  };
}

module.exports = {
  MARKER,
  OPEN_CALLS,
  CLOSE_CALLS,
  ALLOWED_TOOLS,
  decodeDsmlEntities,
  parseDsmlCall,
  createDsmlExtractor,
};
