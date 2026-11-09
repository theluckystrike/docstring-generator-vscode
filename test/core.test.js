'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const scan = require('../src/core/scan');
const py = require('../src/core/python');
const R = require('../src/core/render');
const U = require('../src/core/update');
const J = require('../src/core/jsdoc');

const G = { style: 'google', includeTypes: 'always' };
const src = (t) => scan.fromText(t);
async function gen(text, line, o = G, mode = 'below') {
  const a = await py.analyze(src(text), line, { mode });
  if (a.error) return { error: a.error };
  return { a, text: R.toText(R.renderDocstring(a.info, o, a.bodyIndent).text) };
}
function lineOf(text, needle) { return text.split('\n').findIndex((l) => l.includes(needle)); }
/** Put a generated docstring in place of line L and check the result parses as Python (tree-sitter, no Python needed). */
async function insertAt(text, L, doc) {
  const lines = text.split('\n'); lines.splice(L, 1, doc); return lines.join('\n');
}
async function parsesClean(text) {
  const ts = require('../src/core/ts');
  return ts.withTree('python', text, (root) => !root.hasError);
}

const MODERN = `from typing import Iterator, AsyncIterator

def buy(item: str | None, /, qty: int = 1, *args: int, force: bool = False, **kw: dict[str, list[int]]) -> list[int]:

    if qty < 0:
        raise ValueError("negative")
    def inner():
        raise KeyError("only inner")
    try:
        pass
    except (OSError, IOError) as err:
        raise err
    return [qty]
`;

test('signature: positional-only, keyword-only, *args, **kwargs, unions and generics (rival #262)', async () => {
  const r = await gen(MODERN, 3);
  const p = r.a.info.params;
  assert.deepEqual(p.map((x) => x.star + x.name), ['item', 'qty', '*args', 'force', '**kw']);
  assert.deepEqual(p.map((x) => x.kind), ['posonly', 'normal', 'vararg', 'kwonly', 'kwarg']);
  assert.equal(p[0].type, 'str | None');
  assert.equal(p[4].type, 'dict[str, list[int]]');
  assert.match(r.text, /^    """Summary\.\n\n    Args:\n        item \(str \| None\): Description of item\.\n        qty \(int, optional\): Description of qty\. Defaults to 1\./);
  assert.match(r.text, /\*args \(int\): Description of args\./);
  assert.match(r.text, /\*\*kw \(dict\[str, list\[int\]\]\): Description of kw\./);
  assert.match(r.text, /Returns:\n        list\[int\]: Description of the return value\./);
});

test('raise: found in the body, nested defs ignored, `raise err` resolved to the except types', async () => {
  const r = await gen(MODERN, 3);
  assert.deepEqual(r.a.info.raises, ['ValueError', 'OSError', 'IOError']);
  assert.ok(!r.text.includes('KeyError'));
});

test('the 4 styles render the same function', async () => {
  const out = {};
  for (const style of ['google', 'numpy', 'sphinx', 'epytext']) out[style] = (await gen(MODERN, 3, { style, includeTypes: 'always' })).text;
  assert.match(out.numpy, /Parameters\n    ----------\n    item : str \| None\n        Description of item\.\n    qty : int, default 1\n/);
  assert.match(out.numpy, /Raises\n    ------\n    ValueError\n        Raised when \.\.\./);
  assert.match(out.sphinx, /:param qty: Description of qty, defaults to 1\.\n    :type qty: int, optional\n/);
  assert.match(out.sphinx, /:rtype: list\[int\]\n    :raises ValueError: Raised when \.\.\./);
  assert.match(out.epytext, /@param item: Description of item\.\n    @type item: str \| None\n/);
  assert.match(out.epytext, /@raise OSError: Raised when \.\.\./);
  for (const s of Object.values(out)) assert.ok(await parsesClean(await insertAt(MODERN, 3, s)), 'valid Python after insert');
});

test('yield: Yields section with the item type; async generators too; -> None has no Returns', async () => {
  const t = `def g(n: int) -> Iterator[str]:\n\n    yield "a"\n\nasync def h() -> AsyncIterator[bytes]:\n\n    yield b""\n\ndef n(x) -> None:\n\n    return\n\ndef v(x):\n\n    return x * 2\n`;
  assert.match((await gen(t, 1)).text, /Yields:\n        str: Description of the yielded values\./);
  assert.match((await gen(t, 5)).text, /Yields:\n        bytes:/);
  const none = await gen(t, 9);
  assert.ok(!/Returns/.test(none.text));
  assert.match((await gen(t, 13)).text, /Returns:\n        type: Description of the return value\./);
});

test('dataclass fields become Attributes (rival #170)', async () => {
  const t = `from dataclasses import dataclass\n\n@dataclass\nclass MyClass:\n\n    para_a: int = 1\n    para_b: str = None\n    para_c: Tuple[int, str] = (1, 'a')\n    LIMIT: ClassVar[int] = 3\n`;
  const r = await gen(t, 4);
  assert.equal(r.a.kind, 'class');
  assert.match(r.text, /Attributes:\n        para_a \(int\): Description of para_a\. Defaults to 1\.\n        para_b \(str\): Description of para_b\. Defaults to None\.\n        para_c \(Tuple\[int, str\]\):/);
  assert.ok(!r.text.includes('LIMIT'));
  assert.ok(!r.text.includes('Args:'));
});

test('class docstring lists __init__ arguments, not the base classes (rival #246)', async () => {
  const t = `class A(SuperA, SuperB, SuperC):\n\n    def __init__(self, apple, bat: int, cat=None):\n        self.apple = apple\n        self.bat = bat\n        self._hidden = 1\n`;
  const r = await gen(t, 1);
  assert.match(r.text, /Args:\n        apple \(type\): Description of apple\.\n        bat \(int\): Description of bat\.\n        cat \(type, optional\): Description of cat\. Defaults to None\./);
  assert.match(r.text, /Attributes:\n        apple \(type\):[^\n]*\n        bat \(int\):/);
  assert.ok(!/SuperA|_hidden/.test(r.text));
});

test('a triple-quoted string in the body does not block generation (rival #311, #68)', async () => {
  const t = `def get_person_from_name(name: str) -> str:\n    """\n    query = """\n        SELECT name FROM person_table WHERE name=$1\n    """\n    return query\n`;
  // line 1 holds the """ the user just typed; the SQL string follows
  const r = await gen(t, 1);
  assert.ok(!r.error, r.error);
  assert.match(r.text, /name \(str\): Description of name\./);
  assert.match(r.text, /Returns:\n        str:/);
});

test('aligned continuation lines: docstring uses the body indent, not a guess (rival #315)', async () => {
  const t = `def f(a,\n      b: int = 2,\n      c=None) -> str:\n    \n    return 'x'\n`;
  const r = await gen(t, 3);
  assert.equal(r.a.bodyIndent, '    ');
  assert.ok(r.text.startsWith('    """Summary.'));
  assert.ok(await parsesClean(await insertAt(t, 3, r.text)));
});

test('module docstring at the top has no indent (rival #152)', async () => {
  const t = `#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n\nimport os\n`;
  const r = await gen(t, 2);
  assert.equal(r.a.kind, 'module');
  assert.equal(r.text, '"""Summary."""');
});

test('non-ASCII names and types (rival #183, #308)', async () => {
  const t = `def create_device(user: Union[Benutzer, str], name: str, info: str="{}", größe: int = 1, café=None) -> Optional[Gerät]:\n\n    pass\n`;
  const r = await gen(t, 1);
  assert.deepEqual(r.a.info.params.map((p) => p.name), ['user', 'name', 'info', 'größe', 'café']);
  assert.match(r.text, /Returns:\n        Optional\[Gerät\]:/);
});

test('lambda: nothing to insert, a clear reason', async () => {
  const t = `square = lambda x: x * x\n\n`;
  const r = await py.analyze(src(t), 1, { mode: 'below' });
  assert.equal(r.error, 'lambda');
});

test('one-line def body is refused with a reason', async () => {
  const t = `def f(): return 1\n\n`;
  assert.equal((await py.analyze(src(t), 0, { mode: 'enclosing' })).error, 'inline');
});

test('a syntax error elsewhere in the file does not stop a valid def', async () => {
  const t = `x = (1, 2\n\ndef ok(a: int) -> int:\n\n    return a\n\ndef bad(:\n    pass\n`;
  const r = await gen(t, 3);
  assert.ok(!r.error, r.error);
  assert.match(r.text, /a \(int\): Description of a\./);
  const bad = await py.analyze(src(t), 7, { mode: 'below' });
  assert.ok(bad.error || bad.info, 'no crash on a broken def');
});

test('12-line signature with comments inside', async () => {
  const t = `def long(\n    a: int,  # first\n    b: str = "x",  # second\n    # a comment line\n    c: float = 1.0,\n    *,\n    d: bool = False,\n    e: list[int] | None = None,\n    f=3,\n    g: "Forward" = None,\n    **rest,\n) -> dict:\n\n    return {}\n`;
  const r = await gen(t, 12);
  assert.deepEqual(r.a.info.params.map((p) => p.name), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'rest']);
  assert.equal(r.a.info.params[3].kind, 'kwonly');
  assert.ok(!r.text.includes('#'));
});

test('tabs: the docstring uses the tab indent of the body', async () => {
  const t = `class T:\n\tdef m(self, x):\n\t\t\n\t\treturn x\n`;
  const r = await gen(t, 2);
  assert.equal(r.a.bodyIndent, '\t\t');
  assert.deepEqual(r.a.info.params.map((p) => p.name), ['x'], 'self is skipped in a method');
  assert.ok(r.text.startsWith('\t\t"""'));
});

test('methods: self and cls skipped, staticmethod keeps its first parameter, property has no Returns', async () => {
  const t = `class K:\n    @staticmethod\n    def s(a, b):\n\n        return a\n\n    @classmethod\n    def c(cls, a):\n\n        return cls\n\n    @property\n    def p(self) -> int:\n\n        return 1\n`;
  assert.deepEqual((await gen(t, 3)).a.info.params.map((p) => p.name), ['a', 'b']);
  assert.deepEqual((await gen(t, 8)).a.info.params.map((p) => p.name), ['a']);
  const p = await gen(t, 13);
  assert.equal(p.text, '        """Summary."""');
});

test('snippet: placeholders become tab stops and $ in defaults is escaped', async () => {
  const t = `def price(v="$5", w: str = "}"):\n\n    pass\n`;
  const a = await py.analyze(src(t), 1, { mode: 'below' });
  const s = R.toSnippet(R.renderDocstring(a.info, G, a.bodyIndent).text);
  assert.match(s, /\$\{1:Summary\.\}/);
  assert.match(s, /Defaults to "\\\$5"\./);
  assert.match(s, /Defaults to "\\}"\./);
});

test('includeTypes never and hinted', async () => {
  const t = `def f(a, b: int) -> str:\n\n    return ""\n`;
  const never = (await gen(t, 1, { style: 'google', includeTypes: 'never' })).text;
  assert.match(never, /a: Description of a\.\n        b: Description of b\./);
  assert.match(never, /Returns:\n        Description of the return value\./);
  const hinted = (await gen(t, 1, { style: 'google', includeTypes: 'hinted' })).text;
  assert.match(hinted, /a: Description of a\.\n        b \(int\):/);
});

test('summary on new line and blank line after last section (pydocstyle D213, D413)', async () => {
  const t = `def f(a):\n\n    pass\n`;
  const r = (await gen(t, 1, { ...G, summaryOnNewLine: true, blankLineAfterLastSection: true })).text;
  assert.match(r, /^    """\n    Summary\.\n\n    Args:\n        a \(type\): Description of a\.\n\n    """$/);
});

test('custom Mustache template', async () => {
  const tpl = `{{! my template }}\n{{summaryPlaceholder}}\n\n{{#parametersExist}}\nArguments:\n{{#args}}\n    {{var}} -- {{typePlaceholder}}: {{descriptionPlaceholder}}\n{{/args}}\n{{#kwargs}}\n    {{var}} -- {{typePlaceholder}} (default {{&default}}): {{descriptionPlaceholder}}\n{{/kwargs}}\n{{/parametersExist}}\n\n{{#returnsExist}}\nReturns:\n{{#returns}}\n    {{typePlaceholder}}: {{descriptionPlaceholder}}\n{{/returns}}\n{{/returnsExist}}\n{{^exceptionsExist}}\nNo exceptions.\n{{/exceptionsExist}}\n`;
  const t = `def f(a: int, b=2) -> str:\n\n    return "x"\n`;
  const r = (await gen(t, 1, { style: 'custom', template: tpl })).text;
  assert.equal(r, '    """Summary.\n\n    Arguments:\n        a -- int: Description of a.\n        b -- type (default 2): Description of b.\n\n    Returns:\n        str: Description of the return value.\n    No exceptions.\n    """');
});

// ---------------- update ----------------

async function upd(text, o = G) {
  const a = await py.analyze(src(text), 0, { mode: 'enclosing' });
  assert.ok(a.doc, 'has a docstring');
  return U.updateDocstring(a.doc, a.info, o, '    ');
}

test('update: renamed parameter keeps its text, new one added, removed one with text is marked (rival #28, #177, #255)', async () => {
  const t = `def changed(alpha: int, b: str = "x", c=None) -> int:\n    """Start the engine.\n\n    Longer text the user wrote.\n\n    Args:\n        a (int): The first value, written by hand.\n            It continues here.\n        b (str): Beta text. Defaults to "y".\n        gone (float): Real text about a removed one.\n        junk (type): Description of junk.\n\n    Example:\n        >>> changed(1)\n    """\n    return 1\n`;
  const u = await upd(t);
  assert.ok(u.changed);
  assert.match(u.text, /alpha \(int\): The first value, written by hand\.\n            It continues here\./);
  assert.match(u.text, /b \(str, optional\): Beta text\. Defaults to "x"\./);
  assert.match(u.text, /c \(type, optional\): Description of c\. Defaults to None\./);
  assert.match(u.text, /gone \(float\): \[removed from the signature\] Real text about a removed one\./);
  assert.ok(!u.text.includes('junk'));
  assert.match(u.text, /Longer text the user wrote\./);
  assert.match(u.text, /Returns:\n        int: Description of the return value\.\n\n    Example:\n        >>> changed\(1\)/);
  assert.ok(u.notes.includes('renamed a to alpha'));
});

test('update: NumPy, Sphinx and Epytext keep their own style and text', async () => {
  const np = await upd(`def s(alpha: int, beta: str = "x") -> list[int]:\n    """Start.\n\n    Parameters\n    ----------\n    a : float\n        The first value.\n\n    Returns\n    -------\n    int\n        The count.\n    """\n`);
  assert.equal(np.style, 'numpy');
  assert.match(np.text, /alpha : int\n        The first value\.\n    beta : str, default "x"\n        Description of beta\./);
  assert.match(np.text, /Returns\n    -------\n    list\[int\]\n        The count\./);
  const sp = await upd(`def s(alpha: int, beta: str = "x") -> list[int]:\n    """Start.\n\n    :param a: The first value.\n    :type a: float\n    :return: The count.\n    :rtype: int\n    """\n`);
  assert.equal(sp.style, 'sphinx');
  assert.match(sp.text, /:param alpha: The first value\.\n    :type alpha: int\n    :param beta: Description of beta, defaults to "x"\.\n    :type beta: str, optional\n    :return: The count\.\n    :rtype: list\[int\]/);
  const ep = await upd(`def s(alpha, beta=3):\n    """Start.\n\n    @param a: The first value.\n    """\n`);
  assert.equal(ep.style, 'epytext');
  assert.match(ep.text, /@param alpha: The first value\.\n    @param beta: Description of beta, defaults to 3\./);
});

test('update: one-line docstring grows sections; up-to-date docstring is unchanged', async () => {
  const one = await upd(`def s(a, b=3) -> int:\n    """Start it."""\n    return 1\n`);
  assert.match(one.text, /^"""Start it\.\n\n    Args:\n        a \(type\): Description of a\.\n        b \(type, optional\): Description of b\. Defaults to 3\.\n\n    Returns:\n        int: Description of the return value\.\n    """$/);
  const same = await upd(`def s(a: int) -> int:\n    """Start.\n\n    Args:\n        a (int): A.\n\n    Returns:\n        int: B.\n    """\n`);
  assert.equal(same.changed, false);
});

test('update: new raise added to Raises, existing ones kept', async () => {
  const u = await upd(`def s(a):\n    """S.\n\n    Args:\n        a: A.\n\n    Raises:\n        KeyError: When missing.\n    """\n    if a: raise ValueError()\n    raise KeyError()\n`);
  assert.match(u.text, /Raises:\n        KeyError: When missing\.\n        ValueError: Raised when \.\.\./);
});

test('update: delete mode drops removed parameters', async () => {
  const u = await upd(`def s(b):\n    """S.\n\n    Args:\n        b: B.\n        a: Real text.\n    """\n`, { ...G, removedParameters: 'delete' });
  assert.ok(!u.text.includes('Real text'));
});

// ---------------- whole file ----------------

test('analyzeFile: every def and class with docstring facts', async () => {
  const t = fs.readFileSync(path.join(__dirname, 'fixtures', 'mixed.py'), 'utf8');
  const defs = await py.analyzeFile(t);
  const names = defs.map((d) => d.info.name);
  assert.ok(names.includes('Shop') && names.includes('buy') && names.includes('helper'));
  const buy = defs.find((d) => d.info.name === 'buy');
  assert.ok(buy.doc && buy.info.kind === 'function');
  const helper = defs.find((d) => d.info.name === 'helper');
  assert.equal(helper.doc, null);
});

test('large file: 10,000+ lines, generation at the end answers in under 100 ms', async () => {
  const parts = [];
  for (let i = 0; i < 1300; i++) parts.push(`def f${i}(a: int, b: str = "x", *args, **kw) -> int:\n    """Doc."""\n    if a:\n        raise ValueError(a)\n    return a + ${i}\n`, '', '');
  parts.push('class Last:\n    def target(self, x: list[int] | None, /, y=1, *, z: bool) -> dict[str, int]:\n\n        return {}\n');
  const text = parts.join('\n');
  const s = src(text);
  assert.ok(s.count > 10000, String(s.count));
  const L = s.count - 3;
  await py.analyze(s, L, { mode: 'below' }); // warm
  const t0 = performance.now();
  const a = await py.analyze(s, L, { mode: 'below' });
  const ms = performance.now() - t0;
  assert.equal(a.info.name, 'target');
  assert.deepEqual(a.info.params.map((p) => p.name), ['x', 'y', 'z']);
  assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
  const t1 = performance.now();
  const defs = await py.analyzeFile(text);
  const msAll = performance.now() - t1;
  assert.equal(defs.length, 1302);
  assert.ok(msAll < 3000, `whole file ${msAll.toFixed(0)} ms`);
});

// ---------------- JSDoc ----------------

test('JSDoc for TypeScript: types, optional, default, rest, generics, @returns and @throws', async () => {
  const t = `export async function load<T>(url: string, opts?: Options, retries = 3, ...rest: number[]): Promise<T> {\n  if (!url) throw new TypeError("no url");\n  const f = () => { throw new RangeError("inner"); };\n  return fetchIt(url);\n}\n`;
  const a = await J.analyze(t, 'typescript', 0);
  const d = R.toText(J.render(a.info, G, a.indent));
  assert.equal(d, ['/**', ' * Summary.', ' *', ' * @template T', ' * @param {string} url - Description of url.', ' * @param {Options} [opts] - Description of opts.',
    ' * @param {number} [retries=3] - Description of retries.', ' * @param {...number} rest - Description of rest.', ' * @returns {Promise<T>} Description of the return value.',
    ' * @throws {TypeError} Raised when ...', ' */'].join('\n'));
});

test('JSDoc for JavaScript: types from defaults, destructured parameters, generators', async () => {
  const t = `const add = (a, b = 2, { c, d = 'x' }) => a + b;\nfunction* gen(n) { yield n; }\n`;
  let a = await J.analyze(t, 'javascript', 0);
  const d = R.toText(J.render(a.info, G, a.indent));
  assert.match(d, /@param \{number\} \[b=2\]/);
  assert.match(d, /@param \{Object\} param2 - /);
  assert.match(d, /@param \{string\} \[param2\.d='x'\]/);
  a = await J.analyze(t, 'javascript', 1);
  assert.match(R.toText(J.render(a.info, G, a.indent)), /@yields Description of the yielded values\./);
});

test('JSDoc update: renamed parameters keep their text, types follow TypeScript, @throws added', async () => {
  const t = `class Store {\n  /**\n   * Put a thing.\n   * @param {string} k - The key, by hand.\n   */\n  put(key: string, value: unknown): void {\n    throw new RangeError('x');\n  }\n}\n`;
  const a = await J.analyze(t, 'typescript', 5);
  assert.ok(a.existing);
  const u = J.updateBlock(a.existing.text, a.info, G, a.indent);
  assert.match(u.text, /@param \{string\} key - The key, by hand\.\n {3}\* @param \{unknown\} value - Description of value\.\n {3}\* @throws \{RangeError\} Raised when \.\.\./);
});

// ---------------- package ----------------

test('package: engines floor, types, name, no network in the extension code', () => {
  const pk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pk.engines.vscode, '^1.90.0');
  assert.equal(pk.devDependencies['@types/vscode'], '~1.90.0');
  assert.match(pk.displayName, /^Docstring Generator & Python Docstring Updater/);
  assert.ok(!pk.dependencies, 'no runtime dependencies: tree-sitter is vendored');
  for (const f of ['extension.js', 'core/scan.js', 'core/python.js', 'core/render.js', 'core/update.js', 'core/jsdoc.js', 'core/ts.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.ok(!/require\(['"](https?|net|tls|dgram|child_process)['"]\)|\bfetch\(/.test(s), f);
  }
  for (const w of ['tree-sitter.cjs', 'tree-sitter.wasm', 'tree-sitter-python.wasm', 'tree-sitter-tsx.wasm', 'tree-sitter-typescript.wasm']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'vendor', w)), w);
});

test('Pro is off: the coverage report is the only Pro candidate and runs free', () => {
  const P = require('../src/pro');
  assert.equal(P.PRO_ENABLED, false);
  assert.deepEqual(P.PRO_FEATURES, ['Docstring coverage report']);
});

// ---------------- regressions found by the real VS Code gate ----------------

test('gate bug 1: a trigger line at column 0 (and its auto-closed quotes) still reads the whole body', async () => {
  for (const trig of ['"""', '""""""', '"', '']) {
    const t = `def f(a):\n${trig}\n    if a:\n        raise ValueError(a)\n    return a\n`;
    const r = await gen(t, 1);
    assert.deepEqual(r.a.info.raises, ['ValueError'], JSON.stringify(trig));
    assert.ok(r.a.info.returns, 'Returns found');
    assert.equal(r.a.bodyIndent, '    ');
  }
  const t2 = `def f(a):\n"""\n"""\n    raise KeyError(a)\n`;
  const r2 = await gen(t2, 1);
  assert.deepEqual(r2.a.info.raises, ['KeyError']);
});

test('gate bug 2: mixed tabs and spaces: the auto-closed quote line does not decide the indent', async () => {
  const t = `def space_func(x):\n\t"""\n\t"""\n    return x * 2\n`;
  const r = await gen(t, 1);
  assert.equal(r.a.bodyIndent, '    ');
});

test('gate bug 3: escaped *args in Sphinx kept as written; quoted forward references lose their quotes; bulk leaves one-liners alone', async () => {
  const sp = await upd(`def f(a, **kwargs):\n    """S.\n\n    :param a: A.\n    :param \\*\\*kwargs: Extra options.\n    """\n`);
  assert.match(sp.text, /:param \\\*\\\*kwargs: Extra options\./);
  assert.ok(!/removed/.test(sp.text));
  const r = await gen(`def prep(self) -> "PreparedRequest":\n\n    return 1\n`, 1);
  assert.match(r.text, /Returns:\n        PreparedRequest:/);
  const one = await upd(`def s(a, b=3) -> int:\n    """Start it."""\n    return 1\n`, { ...G, bulk: true });
  assert.equal(one.changed, false);
});

test('update: the same type at the same position is not a rename (signature -> insured stays marked)', async () => {
  const u = await upd(`def ship(order_id: int, carrier: str, insured: bool = False) -> str:\n    """Send.\n\n    Args:\n        order (int): The order number.\n        carrier (str): Carrier code.\n        signature (bool): Ask for a signature.\n    """\n`);
  assert.match(u.text, /order_id \(int\): The order number\./);
  assert.match(u.text, /insured \(bool, optional\): Description of insured\. Defaults to False\./);
  assert.match(u.text, /signature \(bool\): \[removed from the signature\] Ask for a signature\./);
});
