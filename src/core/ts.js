'use strict';
// Lazy tree-sitter loader. The runtime and each grammar load on first use only (about 20 ms), from vendor/.
// No network: locateFile points at the packaged wasm files.
const fs = require('fs');
const path = require('path');

const VENDOR = path.join(__dirname, '..', '..', 'vendor');
let initPromise = null;
const languages = new Map();
const parsers = new Map();

function init() {
  if (!initPromise) {
    initPromise = (async () => {
      const TS = require(path.join(VENDOR, 'tree-sitter.cjs'));
      await TS.Parser.init({ locateFile: (f) => path.join(VENDOR, f) });
      return TS;
    })();
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

/** lang: 'python' | 'typescript' | 'tsx'. Returns a ready parser (one per language, reused). */
async function parserFor(lang) {
  if (parsers.has(lang)) return parsers.get(lang);
  const TS = await init();
  // Pass the bytes, not the path: with a path, web-tree-sitter 0.25 reads the file through a dynamic import("fs/promises"),
  // and the VS Code 1.90-1.9x extension host (the engines floor, Cursor, Windsurf) rejects dynamic import from CommonJS
  // with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING, so every command failed there.
  if (!languages.has(lang)) languages.set(lang, await TS.Language.load(new Uint8Array(fs.readFileSync(path.join(VENDOR, `tree-sitter-${lang}.wasm`)))));
  const p = new TS.Parser();
  p.setLanguage(languages.get(lang));
  parsers.set(lang, p);
  return p;
}

/** Parse text and run fn(rootNode); the tree is freed afterwards. */
async function withTree(lang, text, fn) {
  const p = await parserFor(lang);
  const tree = p.parse(text);
  try { return fn(tree.rootNode); } finally { tree.delete(); }
}

module.exports = { init, parserFor, withTree, VENDOR };
