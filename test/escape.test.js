'use strict';
// VER15 red-team (9 Nov 2026): text copied from the code into a docstring or a JSDoc block must not end it early
// or add invalid escapes. Before the fix, sep='"""' ended the docstring (SyntaxError in all 4 styles),
// rx=r'\d+' gave an invalid escape (SyntaxWarning, an error in a later Python), and pattern = '**/*.ts'
// ended the /** */ block in JS/TS.
const test = require('node:test');
const assert = require('node:assert/strict');
const scan = require('../src/core/scan');
const py = require('../src/core/python');
const R = require('../src/core/render');
const U = require('../src/core/update');
const J = require('../src/core/jsdoc');
const ts = require('../src/core/ts');

const STYLES = ['google', 'numpy', 'sphinx', 'epytext'];
const parsesClean = (text, lang = 'python') => ts.withTree(lang, text, (root) => !root.hasError);

// The docstring literal must close where we put the closing quotes: find the string node that starts at the docstring.
async function docstringValue(text, row) {
  return ts.withTree('python', text, (root) => {
    let found = null;
    const v = (n) => { if (found) return; if (n.type === 'string' && n.startPosition.row === row) { found = n; return; } for (const c of n.children) v(c); };
    v(root);
    return found ? { startRow: found.startPosition.row, endRow: found.endPosition.row, text: found.text } : null;
  });
}

const TRAPS = `def tq(sep='"""', other="'''", rx=r'\\d+\\s"', path='C:\\\\', nl="\\n") -> "Literal['\\"\\"\\"']":
    return sep
`;

test('triple quotes and backslashes in defaults and types do not end the docstring (4 styles, both quote styles)', async () => {
  for (const quote of ['"""', "'''"]) {
    for (const style of STYLES) {
      const a = await py.analyze(scan.fromText(TRAPS), 0, { mode: 'enclosing' });
      assert.ok(!a.error, a.error);
      const doc = R.toText(R.renderDocstring(a.info, { style, includeTypes: 'always', quote }, a.bodyIndent).text);
      const lines = TRAPS.split('\n'); lines.splice(a.insertLine, 0, doc);
      const out = lines.join('\n');
      assert.ok(await parsesClean(out), `${style} ${quote} parses:\n${out}`);
      const n = await docstringValue(out, a.insertLine);
      assert.ok(n, 'docstring node found');
      assert.equal(n.endRow, a.insertLine + doc.split('\n').length - 1, `${style} ${quote}: the docstring ends on its closing line`);
      assert.ok(!/(^|[^\\])\\d/.test(doc), `${style}: no bare \\d escape`);
      assert.match(doc, /\\\\d\+/, `${style}: the regex default is shown with an escaped backslash`);
    }
  }
});

test('analyzeFile (Add Missing / Update All / coverage) gets the same escaped text', async () => {
  const defs = await py.analyzeFile(TRAPS);
  const sep = defs[0].info.params.find((p) => p.name === 'sep');
  assert.equal(sep.default, `'\\"\\"\\"'`);
  assert.equal(py.docSafe('a\\b"""c\'\'\'d'), 'a\\\\b\\"\\"\\"c\\\'\\\'\\\'d');
});

test('update: a new parameter whose default holds triple quotes keeps the file valid', async () => {
  const t = `def f(a, sep='"""'):\n    """Join.\n\n    Args:\n        a (type): The first value.\n    """\n    return a\n`;
  const a = await py.analyze(scan.fromText(t), 0, { mode: 'enclosing' });
  const u = U.updateDocstring(a.doc, a.info, { style: 'google', includeTypes: 'always' }, '    ');
  assert.ok(u.changed);
  const lines = t.split('\n');
  const out = [...lines.slice(0, a.doc.startRow), ...u.text.split('\n'), ...lines.slice(a.doc.endRow + 1)].join('\n');
  assert.ok(await parsesClean(out), out);
  assert.match(out, /Defaults to '\\"\\"\\"'\./);
});

test('update: "$1" and "$&" in a default stay literal', async () => {
  const t = `def f(fmt="$1-$&"):\n    """Format.\n\n    Args:\n        fmt (type, optional): The format. Defaults to "x".\n    """\n`;
  const a = await py.analyze(scan.fromText(t), 0, { mode: 'enclosing' });
  const u = U.updateDocstring(a.doc, a.info, { style: 'google', includeTypes: 'always' }, '    ');
  assert.match(u.text, /Defaults to "\$1-\$&"\./);
});

test('JSDoc: "*/" in a default (a glob) does not end the comment', async () => {
  const t = `export function glob(pattern = '**/*.ts', end = "*/"): string[] {\n  return [pattern, end];\n}\n`;
  const a = await J.analyze(t, 'typescript', 0);
  const doc = R.toText(J.render(a.info, { style: 'google', includeTypes: 'always' }, a.indent));
  assert.equal((doc.match(/\*\//g) || []).length, 1, 'only the closing */');
  assert.match(doc, /\[pattern='\*\*\\\/\*\.ts'\]/);
  assert.ok(await parsesClean(doc + '\n' + t, 'typescript'), doc);
});
