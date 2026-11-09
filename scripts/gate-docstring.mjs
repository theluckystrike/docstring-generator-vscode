// NBUILD11 real-app gate for zovo.zovo-docstring-generator.
// Usage: node gate-docstring.mjs [--vsix PATH] [--port 9281] [--tag NAME] [--cases a,b,...] [--pylance]
//   Env FD_VSCODE_APP=/Applications/Cursor.app runs it in Cursor (see vsc.mjs).
// Works on copies of ~/docstring-generator-work/fixtures in ~/docstring-generator-work/gate/<tag>/ws.
// Output: out/NBUILD11-data/gate-<tag>.json, gate-<tag>.txt, shots in out/NBUILD11-data/shots-<tag>/.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { spawnSync } from 'node:child_process';
import { launch, installVsix, writeSettings, sleep, CLI } from './vsc.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);
const HOME = os.homedir();
const VSIX = arg('vsix', HOME + '/plugin-market-intel-work/factory/products/docstring-generator-vscode/dist/zovo-docstring-generator-0.1.0.vsix');
const PORT = Number(arg('port', 9281));
const TAG = arg('tag', 'base');
const ONLY = arg('cases', '') ? arg('cases').split(',') : null;
const FIX = HOME + '/docstring-generator-work/fixtures';
const W = HOME + '/docstring-generator-work/gate/' + TAG;
const OUT = HOME + '/plugin-market-intel-work/run-20261107/wave14/out/NBUILD11-data';
const SHOTS = path.join(OUT, 'shots-' + TAG);
const TLOG = path.join(W, 'timing.jsonl');

// ---------------------------------------------------------------- text helpers
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n');
function findDef(f, re, nth = 0) {
  const L = lines(f); let k = 0;
  for (let i = 0; i < L.length; i++) if (re.test(L[i])) { if (k++ === nth) return i; }
  throw new Error('def not found: ' + re + ' in ' + path.basename(f));
}
// row (0-based) of the line that ends the header that starts at row i (depth 0 and ends with ':')
function sigEnd(L, i) {
  let depth = 0;
  for (let r = i; r < L.length; r++) {
    let s = L[r], q = null;
    for (let c = 0; c < s.length; c++) {
      const ch = s[c];
      if (q) { if (ch === '\\') c++; else if (ch === q) q = null; continue; }
      if (ch === '#') { s = s.slice(0, c); break; }
      if (ch === '"' || ch === "'") q = ch;
      else if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
    }
    if (depth <= 0 && /:\s*$/.test(s)) return r;
  }
  return i;
}
const indentOf = (s) => s.match(/^[ \t]*/)[0];
// the docstring right under header row h (0-based): {row, indent, text} or null
function docAfter(L, h) {
  let r = h + 1; while (r < L.length && L[r].trim() === '') r++;
  if (r >= L.length) return null;
  const m = L[r].match(/^([ \t]*)[rRuU]{0,2}("""|''')/);
  if (!m) return null;
  const q = m[2]; const rest = L[r].slice(m[0].length);
  if (rest.includes(q)) return { row: r, indent: m[1], text: L[r] };
  let e = r + 1; while (e < L.length && !L[e].includes(q)) e++;
  return { row: r, indent: m[1], text: L.slice(r, e + 1).join('\n') };
}
// body indent of header row h in the ORIGINAL text: first non-blank line after the header end
function bodyIndent(L, h) { let r = h + 1; while (r < L.length && L[r].trim() === '') r++; return indentOf(L[r] || ''); }
function validPy(f) {
  const r = spawnSync('python3', ['-I', '-c', 'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())', f], { encoding: 'utf8' });
  return r.status === 0 ? true : (r.stderr || '').trim().split('\n').pop();
}
function undocumented(f) {
  const r = spawnSync('python3', ['-I', '-c', `import ast,sys
t=ast.parse(open(sys.argv[1],encoding="utf-8").read()); n=0
for x in ast.walk(t):
    if isinstance(x,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)) and not ast.get_docstring(x): n+=1
print(n)`, f], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout.trim()) : -1;
}
const STYLE_TOK = {
  google: { params: 'Args:', raises: 'Raises:', yields: 'Yields:', returns: 'Returns:' },
  numpy: { params: 'Parameters\n', raises: 'Raises\n', yields: 'Yields\n', returns: 'Returns\n' },
  sphinx: { params: ':param ', raises: ':raises ', yields: ':yield', returns: ':return' },
  epytext: { params: '@param ', raises: '@raise ', yields: 'yielded values', returns: '@return' }, // epytext has no yield field: the extension writes @return: ...yielded values
};

// ---------------------------------------------------------------- run state
const results = []; let vs; let style = 'google';
function rec(name, ok, detail = {}) { results.push({ case: name, ok: !!ok, ...detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + ' ' + JSON.stringify(detail).slice(0, 400)); }
async function shot(name) { try { return await vs.shot(path.join(SHOTS, name + '.png')); } catch (e) { return 'shot failed ' + e.message; } }
async function openFile(f) {
  vs.open(f);
  const base = path.basename(f);
  await vs.waitFor(async () => (await vs.activeTitle()).includes(base), 15000, 200);
  await sleep(1200); await vs.focusEditor();
}
async function leaveSnippet() { await vs.key('Escape', 'Escape', 0, 27); await sleep(80); await vs.key('Escape', 'Escape', 0, 27); await sleep(80); }
async function setStyle(s) { style = s; writeSettings(W, { 'zovoDoc.style': s }); await sleep(1500); }

// type """ + Enter under the header of def matched by re (nth match); returns {before, after, h, suggest}
async function tripleEnter(f, re, nth = 0, { accept = 'enter' } = {}) {
  const L0 = lines(f); const d = findDef(f, re, nth); const h = sigEnd(L0, d);
  const nextBlank = h + 1 < L0.length && L0[h + 1].trim() === '';
  if (nextBlank) { await vs.gotoLine(h + 2); await vs.end(); }
  else { await vs.gotoLine(h + 1); await vs.end(); await vs.enter(); }
  await vs.typeKeys('"""');
  const sug = await vs.waitFor(async () => { const s = await vs.suggestLabels(); return s.length ? s : null; }, 2500, 150) || [];
  const shown = sug.some((s) => /Generate Docstring/i.test(s));
  if (accept === 'enter') await vs.enter();
  await sleep(700);
  await leaveSnippet();
  await vs.save(); await sleep(300);
  const L1 = lines(f);
  return { L0, L1, d, h, doc: docAfter(L1, h), want: bodyIndent(L0, h), suggest: shown, suggestRows: sug.slice(0, 3) };
}
async function paletteAt(f, row0, title) {
  await vs.gotoLine(row0 + 1); await vs.end();
  await vs.command('Docstring: ' + title); await sleep(900);
  await leaveSnippet(); await vs.save(); await sleep(300);
}
function has(doc, toks) { const t = doc ? doc.text : ''; return toks.filter((k) => !t.includes(k)); }

// ---------------------------------------------------------------- cases
const CASES = {
  // 10 functions of typed_modern.py in each of the 4 styles
  async styles() {
    for (const s of ['google', 'numpy', 'sphinx', 'epytext']) {
      await setStyle(s);
      const f = path.join(W, 'ws', `typed_modern_${s}.py`); fs.copyFileSync(path.join(FIX, 'typed_modern.py'), f);
      await openFile(f);
      const T = STYLE_TOK[s];
      const spec = [
        ['parse_port', ['value', 'default'], [T.returns]],
        ['group_ids', ['rows', 'key'], [T.returns]],
        ['clamp', ['x', 'lo', 'hi'], []],
        ['connect', ['host', 'port', 'ssl', 'timeout', 'ValueError'], [T.raises]],
        ['log_all', ['messages', 'sep', 'fields'], []],
        ['chunks', ['items', 'size'], [T.yields]],
        ['countdown', ['n'], [T.yields]],
        ['load_config', ['path', 'FileNotFoundError'], [T.raises]],
        ['outer', ['flag', 'PermissionError'], [T.raises]],
        ['mixed', ['a', 'b', 'c', 'args', 'd', 'e', 'kw'], []],
      ];
      for (const [fn, toks, sect] of spec) {
        const r = await tripleEnter(f, new RegExp('^def ' + fn + '\\('));
        const miss = has(r.doc, [...toks, ...sect, 'Summary.']);
        const extra = fn === 'outer' && r.doc && r.doc.text.includes('KeyError') ? ['KeyError from nested def counted'] : [];
        rec(`style:${s}:${fn}`, r.doc && r.doc.indent === r.want && !miss.length && !extra.length,
          { indent: JSON.stringify(r.doc && r.doc.indent), want: JSON.stringify(r.want), missing: miss, extra, suggest: r.suggest });
      }
      const v = validPy(f); rec(`style:${s}:valid-python`, v === true, { v });
      await vs.gotoLine(1); await sleep(300); results.push({ shot: await shot(`style-${s}-top`) });
      await vs.gotoLine(findDef(f, /^def chunks\(/) + 1); await sleep(300); results.push({ shot: await shot(`style-${s}-chunks`) });
    }
    await setStyle('google');
  },

  async fixtures() {
    const F = (n) => { const f = path.join(W, 'ws', n); fs.copyFileSync(path.join(FIX, n), f); return f; };
    const one = async (name, f, re, toks, opts = {}) => {
      const r = await tripleEnter(f, re, opts.nth || 0);
      const miss = has(r.doc, toks);
      const bad = (opts.not || []).filter((k) => r.doc && r.doc.text.includes(k));
      const want = opts.want ?? r.want;
      rec(name, r.doc && r.doc.indent === want && !miss.length && !bad.length,
        { indent: JSON.stringify(r.doc && r.doc.indent), want: JSON.stringify(want), missing: miss, unexpected: bad, suggest: r.suggest });
      return r;
    };
    let f;
    f = F('dataclasses_demo.py'); await openFile(f);
    await one('dataclass:Item', f, /^class Item:/, ['sku', 'name', 'quantity', 'tags', 'location']);
    await one('dataclass:Location(frozen)', f, /^class Location:/, ['aisle', 'shelf', 'note']);
    await one('attrs:Supplier', f, /^class Supplier:/, ['name', 'email', 'rating']);
    await one('class-init-args:Warehouse', f, /^class Warehouse:/, ['name', 'capacity', 'items'], { not: ['_index'] });
    await one('method:total_weight', f, /def total_weight/, ['unit_weight', 'ValueError'], { not: ['self'] });
    rec('dataclasses_demo:valid-python', validPy(f) === true, { v: validPy(f) }); results.push({ shot: await shot('dataclasses') });

    f = F('async_demo.py'); await openFile(f);
    await one('async:fetch_job', f, /^async def fetch_job/, ['client', 'job_id', 'timeout', 'TimeoutError']);
    await one('async-gen:poll_jobs', f, /^async def poll_jobs/, ['client', 'ids', 'interval', 'Yields']);
    await one('async:retry(kw-only)', f, /^async def retry/, ['fn', 'attempts', 'backoff', 'RuntimeError']);
    await one('async-method:Worker.run', f, /async def run/, ['queue'], { not: ['self'] });
    rec('async_demo:valid-python', validPy(f) === true, { v: validPy(f) });

    f = F('overload_property.py'); await openFile(f);
    await one('staticmethod:from_kelvin', f, /def from_kelvin/, ['kelvin', 'ValueError']);
    await one('property:fahrenheit', f, /def fahrenheit\(self\) ->/, ['Summary.'], { not: ['self', 'Args:'] });
    await one('classmethod:freezing', f, /def freezing/, ['Summary.'], { not: ['cls'] });
    await one('overload-impl:scale', f, /^def scale\(value: Union/, ['value', 'factor']);
    rec('overload_property:valid-python', validPy(f) === true, { v: validPy(f) });

    f = F('unicode_names.py'); await openFile(f);
    await one('unicode:create_device(#183)', f, /^def create_device/, ['user', 'name', 'info', 'Gerät']);
    await one('unicode:größe_berechnen', f, /^def größe_berechnen/, ['länge', 'breite', 'höhe']);
    await one('unicode:café_preis(#308)', f, /^def café_preis/, ['número', 'señal']);
    rec('unicode_names:valid-python', validPy(f) === true, { v: validPy(f) }); results.push({ shot: await shot('unicode') });

    f = F('body_triple_quote.py'); await openFile(f);
    await one('body-triple-quote:get_person_from_name(#311)', f, /^def get_person_from_name/, ['conn', 'name', 'LookupError']);
    await one('body-triple-quote:foo(#68)', f, /^def foo/, ['bar']);
    await one('body-triple-quote:report', f, /^def report/, ['rows']);
    rec('body_triple_quote:valid-python', validPy(f) === true, { v: validPy(f) }); results.push({ shot: await shot('body-triple-quote') });

    f = F('aligned_continuation.py'); await openFile(f);
    await one('aligned-continuation:f(#315)', f, /^def f\(a,/, ['a', 'b', 'c'], { want: '    ' });
    await one('aligned-continuation:render', f, /def render/, ['text', 'width', 'indent'], { want: '        ', not: ['self'] });
    rec('aligned_continuation:valid-python', validPy(f) === true, { v: validPy(f) }); results.push({ shot: await shot('aligned-continuation') });

    f = F('long_signature.py'); await openFile(f);
    await one('hostile:long-signature-12-lines', f, /^def build_request/, ['method', 'url', 'params', 'headers', 'data', 'json', 'timeout', 'allow_redirects', 'verify', 'NotImplementedError']);
    rec('long_signature:valid-python', validPy(f) === true, { v: validPy(f) }); results.push({ shot: await shot('long-signature') });

    f = F('tabs_mixed.py'); await openFile(f);
    await one('hostile:tabs:Shape', f, /^class Shape:/, ['sides', 'name'], { want: '\t' });
    await one('hostile:tabs:area', f, /def area/, ['scale', 'ValueError'], { want: '\t\t' });
    await one('hostile:tabs:tab_func', f, /^def tab_func/, ['a', 'b'], { want: '\t' });
    await one('hostile:spaces:space_func', f, /^def space_func/, ['a', 'b'], { want: '    ' });
    rec('tabs_mixed:valid-python', validPy(f) === true, { v: validPy(f) });

    f = F('syntax_error.py'); await openFile(f);
    await one('hostile:syntax-error:valid_after', f, /^def valid_after/, ['path', 'mode']);
    await one('hostile:syntax-error:also_valid', f, /^def also_valid/, ['x']);
    results.push({ shot: await shot('syntax-error') });

    // lambda: """ + Enter on the line under a lambda inserts nothing; the command says why
    f = F('lambda_only.py'); await openFile(f);
    const before = fs.readFileSync(f, 'utf8');
    await vs.gotoLine(2); await vs.end(); await vs.typeKeys('"""'); await sleep(900);
    const sug = await vs.suggestLabels(); await vs.enter(); await sleep(800);
    const sb = await vs.statusBarText(); await leaveSnippet(); await vs.save();
    const after = fs.readFileSync(f, 'utf8');
    rec('hostile:lambda:no-docstring', !after.includes('Summary.'), { suggest: sug.slice(0, 3), statusbar: sb.slice(0, 300) });
    fs.writeFileSync(f, before); await sleep(800);
    await vs.gotoLine(1); await vs.end(); await vs.command('Docstring: Generate Docstring'); await sleep(1200);
    const notes = await vs.notifications(); results.push({ shot: await shot('lambda-message') });
    rec('hostile:lambda:message', notes.some((n) => /lambda/i.test(n)), { notes });
    await vs.dismissNotifications();

    // real modules
    f = F('requests_models.py'); await openFile(f);
    await one('real:requests Request.__init__ (multi-line)', f, /^    def __init__\(\s*$/, ['method', 'url', 'headers', 'files', 'data', 'params', 'auth', 'cookies', 'hooks', 'json'], { not: ['self'] });
    rec('requests_models:valid-python', validPy(f) === true, { v: validPy(f) });
    f = F('attrs_validators.py'); await openFile(f);
    await one('real:attrs __call__', f, /def __call__\(self, inst, attr, value\)/, ['inst', 'attr', 'value']);
    rec('attrs_validators:valid-python', validPy(f) === true, { v: validPy(f) });
    for (const n of ['flask_helpers.py', 'pandas_io_common.py']) {
      f = F(n); const u0 = undocumented(f); await openFile(f);
      await vs.gotoLine(1); await vs.command('Docstring: Add Missing Docstrings in File'); await sleep(2500);
      await leaveSnippet(); await vs.save(); await sleep(400);
      const u1 = undocumented(f);
      rec(`real:add-missing:${n}`, validPy(f) === true && u1 >= 0 && u1 < u0, { undocumentedBefore: u0, after: u1, v: validPy(f) });
    }
    results.push({ shot: await shot('pandas-add-missing') });
    f = F('requests_sessions.py'); const orig = fs.readFileSync(f, 'utf8'); await openFile(f);
    await vs.gotoLine(1); await vs.command('Docstring: Update All Docstrings in File'); await sleep(2500);
    await vs.dismissNotifications(); await leaveSnippet(); await vs.save(); await sleep(400);
    const now = fs.readFileSync(f, 'utf8'); const norm = (s) => s.trim().replace(/^[rRuU]?("""|''')/, '').replace(/("""|''')$/, '').replace(/\\\*/g, '*').trim();
    const nowSet = new Set(now.split('\n').map(norm));
    const lost = orig.split('\n').map(norm).filter((s) => s && !/^:(param|type|rtype|return|raises)/.test(s) && !nowSet.has(s));
    const escChanged = (orig.match(/:param \\\*\\\*\w+:/g) || []).length - (now.match(/:param \\\*\\\*\w+:/g) || []).length;
    rec('real:update-all:requests_sessions (user text kept)', validPy(f) === true && lost.length === 0, { lostLines: lost.slice(0, 8), lostCount: lost.length, escapedKwargsRenamed: escChanged, changedLines: now.split('\n').length - orig.split('\n').length });
  },

  // update after the signature changed; the user's text must stay
  async update(styles = ['google', 'numpy', 'sphinx', 'epytext']) {
    for (const s of styles) {
      await setStyle(s);
      const f = path.join(W, 'ws', `update_${s}.py`);
      fs.writeFileSync(f, 'def parse_port(value: str | None, default: int = 8080) -> int:\n\n    if value is None:\n        return default\n    return int(value)\n');
      await openFile(f);
      await tripleEnter(f, /^def parse_port/);
      // the user writes their own text into the generated docstring
      let t = fs.readFileSync(f, 'utf8')
        .replace(/Description of value(?=[.,])/, 'The raw port string from the environment')
        .replace(/Description of default(?=[.,])/, 'Port used when the value is missing')
        .replace('Summary.', 'Parse a TCP port number.');
      // the signature changes: default -> fallback (rename), a new keyword-only flag
      t = t.replace('def parse_port(value: str | None, default: int = 8080) -> int:', 'def parse_port(value: str | None, fallback: int = 8080, *, strict: bool = False) -> int:')
        .replace('return default', 'return fallback');
      fs.writeFileSync(f, t); await sleep(1500);
      await paletteAt(f, 0, 'Update Docstring (Signature Changed)');
      const L = lines(f); const d = docAfter(L, 0);
      const miss = has(d, ['Parse a TCP port number.', 'The raw port string from the environment', 'Port used when the value is missing', 'fallback', 'strict']);
      const stale = d && /\bdefault\b/.test(d.text.replace(/[Dd]efaults? to|default 8080|, default|Port used/g, '')) ? 'old name still listed' : '';
      rec(`update:${s}:rename+add keeps text`, d && !miss.length && validPy(f) === true, { missing: miss, note: stale, doc: d && d.text.slice(0, 600) });
      results.push({ shot: await shot(`update-${s}`) });
    }
    await setStyle('google');
  },

  async big() {
    const f = path.join(W, 'ws', 'big_10k.py'); fs.copyFileSync(path.join(FIX, 'big_10k.py'), f);
    await openFile(f); await sleep(1500);
    const t0 = fs.existsSync(TLOG) ? fs.readFileSync(TLOG, 'utf8').split('\n').filter(Boolean).length : 0;
    let r = await tripleEnter(f, /^def middle_target/);
    rec('large:10k middle_target', r.doc && r.doc.indent === '    ' && !has(r.doc, ['path', 'retries', 'verbose', 'ValueError']).length, { suggest: r.suggest, doc: r.doc && r.doc.text.slice(0, 300), around: r.L1.slice(r.h, r.h + 4) });
    r = await tripleEnter(f, /^def end_target/);
    rec('large:10k end_target', r.doc && !has(r.doc, ['items', 'key', 'default', 'opts', 'LookupError']).length, { suggest: r.suggest, doc: r.doc && r.doc.text.slice(0, 300), around: r.L1.slice(r.h, r.h + 4) });
    results.push({ shot: await shot('large-end-target') });
    await vs.gotoLine(1); await vs.command('Docstring: Update All Docstrings in File'); await sleep(3000); await vs.dismissNotifications(); await leaveSnippet(); await vs.save();
    rec('large:10k update-all valid', validPy(f) === true, { v: validPy(f) });
    const T = fs.existsSync(TLOG) ? fs.readFileSync(TLOG, 'utf8').split('\n').filter(Boolean).slice(t0).map((l) => JSON.parse(l)) : [];
    const gen = T.filter((x) => x.lines > 10000 && /generate|complet|enter/i.test(x.op));
    rec('large:10k generate < 100 ms', gen.length > 0 && gen.every((x) => x.ms < 100), { timings: T });
  },

  async jsdoc() {
    const F = (n) => { const f = path.join(W, 'ws', n); fs.copyFileSync(path.join(FIX, n), f); return f; };
    const at = async (name, f, re, toks) => {
      const row = findDef(f, re); await paletteAt(f, row, 'Generate JSDoc');
      const txt = fs.readFileSync(f, 'utf8'); const L = txt.split('\n'); const r2 = findDef(f, re);
      let s = r2 - 1; while (s >= 0 && !L[s].includes('/**')) s--;
      const block = s >= 0 && r2 - s < 30 ? L.slice(s, r2).join('\n') : '';
      const miss = toks.filter((k) => !block.includes(k));
      rec(name, block && !miss.length, { missing: miss, block: block.slice(0, 400) });
    };
    let f = F('sample.ts'); await openFile(f);
    await at('jsdoc:ts findUser', f, /^export function findUser/, ['@param', 'users', 'id', '@returns']);
    await at('jsdoc:ts loadUsers', f, /^export async function loadUsers/, ['url', 'timeoutMs', '@throws', 'Error']);
    await at('jsdoc:ts first<T>', f, /^export function first/, ['items', 'fallback']);
    await at('jsdoc:ts Store.set', f, /^  set\(key: K/, ['key', 'value', 'overwrite', '@throws']);
    results.push({ shot: await shot('jsdoc-ts') });
    f = F('sample.js'); await openFile(f);
    await at('jsdoc:js add', f, /^function add/, ['a', 'b']);
    await at('jsdoc:js greet (arrow, destructured)', f, /^const greet/, ['name', 'TypeError']);
    await at('jsdoc:js Cart.addItem', f, /^  addItem/, ['sku', 'qty', 'tags', 'RangeError']);
    results.push({ shot: await shot('jsdoc-js') });
  },

  // short set for the Pylance and Cursor variants: """ + Enter on 3 fixtures, then the update case (Google)
  async quick() {
    const F = (n) => { const f = path.join(W, 'ws', n); fs.copyFileSync(path.join(FIX, n), f); return f; };
    const one = async (name, f, re, toks) => {
      const r = await tripleEnter(f, re); const miss = has(r.doc, toks);
      rec(name, r.doc && r.doc.indent === r.want && !miss.length, { indent: JSON.stringify(r.doc && r.doc.indent), want: JSON.stringify(r.want), missing: miss, suggest: r.suggest, suggestRows: r.suggestRows });
    };
    let f = F('typed_modern.py'); await openFile(f); await sleep(4000);
    await one('quick:typed_modern connect', f, /^def connect\(/, ['host', 'port', 'ssl', 'timeout', 'ValueError', 'Raises:']);
    await one('quick:typed_modern chunks', f, /^def chunks\(/, ['items', 'size', 'Yields:']);
    rec('quick:typed_modern valid', validPy(f) === true, {}); results.push({ shot: await shot('quick-typed-modern') });
    f = F('dataclasses_demo.py'); await openFile(f);
    await one('quick:dataclass Item', f, /^class Item:/, ['sku', 'name', 'quantity']);
    f = F('unicode_names.py'); await openFile(f);
    await one('quick:unicode create_device', f, /^def create_device/, ['user', 'name', 'info']);
    results.push({ shot: await shot('quick-unicode') });
    await CASES.update.call(null, ['google']);
  },

  // Jupyter notebook cell (built-in ipynb editor, no Jupyter extension needed to edit)
  async notebook() {
    const f = path.join(W, 'ws', 'demo.ipynb');
    fs.writeFileSync(f, JSON.stringify({ cells: [{ cell_type: 'code', execution_count: null, id: 'c1', metadata: {}, outputs: [],
      source: ['def area(w: float, h: float) -> float:\n', '    if w < 0:\n', '        raise ValueError("w")\n', '    return w * h\n'] }],
      metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 }, null, 1));
    vs.open(f); await vs.waitFor(async () => (await vs.activeTitle()).includes('demo.ipynb'), 15000, 200); await sleep(3000);
    const focused = await vs.wbEval(`(() => { const e = document.querySelector('.notebook-editor .cell-editor-container .monaco-editor'); if (!e) return 'no cell editor'; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + 40, y: r.y + 8 }); })()`);
    if (!focused.startsWith('{')) { rec('notebook:cell', false, { note: focused }); results.push({ shot: await shot('notebook') }); return; }
    const pt = JSON.parse(focused); await vs.click(pt.x, pt.y); await sleep(400);
    await vs.key('ArrowUp', 'ArrowUp', 4, 38); await vs.end(); await vs.enter(); await vs.typeKeys('"""');
    const sug = await vs.waitFor(async () => { const x = await vs.suggestLabels(); return x.length ? x : null; }, 2500, 150) || [];
    await vs.enter(); await sleep(800); await leaveSnippet(); results.push({ shot: await shot('notebook') });
    await vs.key('s', 'KeyS', 4, 83); await sleep(1200);
    let src = ''; try { src = JSON.parse(fs.readFileSync(f, 'utf8')).cells[0].source; src = Array.isArray(src) ? src.join('') : src; } catch (e) { src = 'read failed ' + e.message; }
    rec('notebook:cell """ + Enter', /Summary\./.test(src) && /w \(float\)/.test(src) && /ValueError/.test(src), { suggest: sug.slice(0, 3), source: src.slice(0, 500) });
  },

  async light() {
    writeSettings(W, { 'workbench.colorTheme': 'Default Light Modern' }); await sleep(2500);
    const f = path.join(W, 'ws', 'typed_modern_google.py');
    if (fs.existsSync(f)) { await openFile(f); await vs.gotoLine(1); }
    results.push({ shot: await shot('light-theme') });
    rec('light-theme screenshot', true, {});
    writeSettings(W, { 'workbench.colorTheme': 'Default Dark Modern' }); await sleep(1500);
  },
};

// ---------------------------------------------------------------- main
fs.rmSync(W, { recursive: true, force: true }); fs.mkdirSync(path.join(W, 'ws'), { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });
const sha = spawnSync('shasum', ['-a', '256', VSIX], { encoding: 'utf8' }).stdout.split(' ')[0];
const inst = installVsix(W, VSIX); console.log('install', inst.code, inst.out.trim().split('\n').pop());
if (flag('pylance')) for (const id of ['ms-python.python', 'ms-python.vscode-pylance']) {
  const r = spawnSync(CLI, ['--user-data-dir', path.join(W, 'ud'), '--extensions-dir', path.join(W, 'ext'), '--install-extension', id], { encoding: 'utf8', timeout: 300000 });
  console.log('install', id, r.status, (r.stdout || '').trim().split('\n').pop());
}
const exts = fs.readdirSync(path.join(W, 'ext')).filter((d) => !d.startsWith('.'));
const t0 = Date.now();
vs = await launch(W, PORT, path.join(W, 'ws'), { 'zovoDoc.style': 'google', 'editor.acceptSuggestionOnEnter': 'on', 'files.autoSave': 'off',
  'python.languageServer': flag('pylance') ? 'Pylance' : undefined }, { ZOVO_DOC_TIMING_LOG: TLOG });
let version = '';
try {
  await sleep(5000);
  version = await vs.wbEval(`(() => { try { return (document.title || '') } catch { return '' } })()`);
  for (const [k, fn] of Object.entries(CASES)) {
    if (ONLY && !ONLY.includes(k)) continue;
    try { await fn(); } catch (e) { results.push({ shot: await shot('crash-' + k) }); let sb = ''; try { sb = await vs.statusBarText(); } catch {} rec(k + ':crashed', false, { error: String(e && e.stack || e).slice(0, 500), statusbar: sb.slice(0, 300) }); }
  }
} finally {
  const ours = vs.console.filter((c) => c.type !== 'warning' && /docstring|zovo/i.test(c.text));
  const all = vs.console.filter((c) => c.type !== 'warning');
  const exthost = vs.extHostLogs().filter((p) => /exthost/.test(p)).map((p) => fs.readFileSync(p, 'utf8')).join('\n')
    .split('\n').filter((l) => /zovo|docstring/i.test(l) && /error|exception/i.test(l)).slice(0, 20);
  await vs.close();
  const pass = results.filter((r) => r.case && r.ok).length, fail = results.filter((r) => r.case && !r.ok).length;
  const timings = fs.existsSync(TLOG) ? fs.readFileSync(TLOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const app = process.env.FD_VSCODE_APP || '/Applications/Visual Studio Code.app';
  const appVer = (() => { try { return JSON.parse(fs.readFileSync(app + '/Contents/Resources/app/package.json', 'utf8')).version; } catch { return '?'; } })();
  const summary = { tag: TAG, app, appVersion: appVer, vsix: VSIX, sha256: sha, extensions: exts, started: new Date(t0).toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    pass, fail, consoleErrorsOurs: ours, consoleErrorsAll: all.length, exthostErrors: exthost, timings, results };
  fs.writeFileSync(path.join(OUT, `gate-${TAG}.json`), JSON.stringify(summary, null, 1));
  const txt = [`NBUILD11 gate ${TAG} ${new Date().toISOString()} app ${app} ${appVer}`, `vsix ${VSIX} sha256 ${sha}`, `extensions: ${exts.join(', ')}`,
    `PASS ${pass} FAIL ${fail}; console errors from the extension: ${ours.length} (all non-warning: ${all.length}); exthost errors: ${exthost.length}`,
    ...results.filter((r) => r.case).map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.case} ${JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !['case', 'ok', 'doc', 'timings'].includes(k)))).slice(0, 300)}`),
    'timings (ZOVO_DOC_TIMING_LOG):', ...timings.map((t) => `  ${t.op} ${t.ms} ms ${t.lines} lines ${path.basename(t.file)} ${t.extra}`),
    'shots:', ...results.filter((r) => r.shot).map((r) => '  ' + r.shot)].join('\n');
  fs.writeFileSync(path.join(OUT, `gate-${TAG}.txt`), txt + '\n');
  console.log(`\nPASS ${pass} FAIL ${fail}  -> ${path.join(OUT, `gate-${TAG}.txt`)}`);
}
