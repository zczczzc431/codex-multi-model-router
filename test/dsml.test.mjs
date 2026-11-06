import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dsml = require('../src/dsml.js');

const BAR = '\uFF5C';
const D = `${BAR}${BAR}DSML${BAR}${BAR}`;

const block = (input, tool = 'exec') => [
  `<${D} calls>`,
  `<${D} invoke name="${tool}">`,
  `<${D} parameter name="input" string="true">`,
  input,
  `</${D} parameter>`,
  `</${D} invoke>`,
  `</${D} calls>`,
].join('\n');

test('parses a complete exec block', () => {
  const call = dsml.parseDsmlCall(block('console.log(7)'));
  assert.equal(call.name, 'exec');
  assert.equal(call.input, 'console.log(7)');
});

test('decodes numeric and named entities', () => {
  const call = dsml.parseDsmlCall(block('console.log(&#x22;a&#x22;) &amp; &#39;b&#39;'));
  assert.equal(call.input, `console.log("a") & 'b'`);
});

test('refuses tools outside the allowlist', () => {
  assert.equal(dsml.parseDsmlCall(block('rm -rf /', 'shell')), null);
});

test('returns null for an incomplete block', () => {
  const partial = block('console.log(7)').slice(0, -20);
  assert.equal(dsml.parseDsmlCall(partial), null);
});

test('detects a marker split across many chunks', () => {
  const source = `先说明一句。\n${block('console.log(42)')}\n尾声。`;
  const extractor = dsml.createDsmlExtractor();
  const text = [];
  const calls = [];
  // Deliberately slice at awkward boundaries so the marker straddles chunks.
  for (let i = 0; i < source.length; i += 3) {
    const out = extractor.push(source.slice(i, i + 3));
    if (out.text) text.push(out.text);
    calls.push(...out.calls);
  }
  const tail = extractor.flush();
  if (tail.text) text.push(tail.text);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'console.log(42)');
  // 标记之后的那个换行属于正文，必须保留，只吞掉工具块本身。
  assert.equal(text.join(''), '先说明一句。\n\n尾声。');
  assert.ok(!text.join('').includes('DSML'));
});

test('holds a partial marker until it completes', () => {
  const extractor = dsml.createDsmlExtractor();
  const B = '\uFF5C';
  const first = extractor.push(`普通文本 <${B}${B}DSM`);
  assert.equal(first.text, '普通文本 ');
  assert.equal(first.calls.length, 0);
});

test('passes ordinary text through untouched', () => {
  const extractor = dsml.createDsmlExtractor();
  const out = extractor.push('hello world');
  assert.equal(out.text, 'hello world');
  assert.equal(out.calls.length, 0);
});
