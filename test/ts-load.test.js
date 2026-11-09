'use strict';
// VER15 red-team (9 Nov 2026): in VS Code 1.90.2 (the engines floor) every command failed with
// "TypeError: A dynamic import callback was not specified" because Language.load(path) reads the file through
// import("fs/promises"). The loader must hand web-tree-sitter the bytes, and the vendored runtime must have no
// other dynamic import on the paths we use.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('grammars load from bytes, never through the dynamic import in Language.load(path)', async () => {
  const VENDOR = path.join(__dirname, '..', 'vendor');
  const TS = require(path.join(VENDOR, 'tree-sitter.cjs'));
  const orig = TS.Language.load;
  const args = [];
  TS.Language.load = function (input) { args.push(input); return orig.call(this, input); };
  try {
    delete require.cache[require.resolve('../src/core/ts')];
    const ts = require('../src/core/ts');
    for (const lang of ['python', 'typescript', 'tsx']) await ts.parserFor(lang);
    assert.equal(args.length, 3);
    for (const a of args) assert.ok(a instanceof Uint8Array, 'Language.load got ' + typeof a);
    assert.equal(await ts.withTree('python', 'def f(a):\n    return a\n', (r) => r.hasError), false);
  } finally {
    TS.Language.load = orig;
    delete require.cache[require.resolve('../src/core/ts')];
  }
  const src = fs.readFileSync(path.join(VENDOR, 'tree-sitter.cjs'), 'utf8');
  assert.equal((src.match(/\bimport\(/g) || []).length, 1, 'the only dynamic import is the one inside Language.load(path)');
});
