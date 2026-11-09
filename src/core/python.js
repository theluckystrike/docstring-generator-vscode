'use strict';
// Reads a Python def or class with tree-sitter: parameters (positional-only, keyword-only, *args, **kwargs),
// type hints, defaults, return type, yield, raise, class attributes, dataclass fields and __init__ arguments.
// Only the def/class block is parsed (see scan.js), so the cost does not grow with the file.
const scan = require('./scan');
const ts = require('./ts');

const DATACLASS_DECOR = /(^|\.)(dataclass|dataclasses\.dataclass|s|attrs|define|frozen|mutable|dataclass_transform)\s*(\(|$)/;
const DATACLASS_BASES = /\b(BaseModel|NamedTuple|TypedDict|Struct|SQLModel|BaseSettings|Schema|Model)\b/;
const GEN_RE = /^(?:typing\.|collections\.abc\.|t\.)?(Iterator|Iterable|Generator|AsyncIterator|AsyncIterable|AsyncGenerator)\[(.*)\]$/s;

function normType(t) {
  if (!t) return '';
  t = t.trim();
  if (/^(["'])[^"']*\1$/.test(t)) t = t.slice(1, -1); // a quoted forward reference: "PreparedRequest"
  return t.replace(/#[^\n]*/g, '').replace(/\s+/g, ' ').replace(/([[(]) /g, '$1').replace(/ ([\])])/g, '$1').replace(/, ?([\])])/g, '$1').trim();
}

function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const c of s) {
    if ('[({'.includes(c)) depth++;
    if ('])}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function yieldType(ret) {
  const m = GEN_RE.exec(ret || '');
  if (!m) return '';
  const parts = splitTop(m[2]);
  return parts[0] || '';
}

function strip(v) { return v.replace(/^['"]|['"]$/g, ''); }

function parseParams(node) {
  const out = [];
  if (!node) return out;
  let kwOnly = false;
  for (const c of node.namedChildren) {
    let name = null, type = '', def = null, star = '';
    switch (c.type) {
      case 'identifier': name = c.text; break;
      case 'typed_parameter': {
        const inner = c.namedChildren.find((x) => x.type !== 'type' && x.type !== 'comment');
        if (inner && inner.type === 'list_splat_pattern') { star = '*'; name = inner.namedChildren[0]?.text; }
        else if (inner && inner.type === 'dictionary_splat_pattern') { star = '**'; name = inner.namedChildren[0]?.text; }
        else name = inner?.text;
        type = normType(c.childForFieldName('type')?.text);
        break;
      }
      case 'default_parameter': name = c.childForFieldName('name')?.text; def = c.childForFieldName('value')?.text; break;
      case 'typed_default_parameter':
        name = c.childForFieldName('name')?.text; type = normType(c.childForFieldName('type')?.text); def = c.childForFieldName('value')?.text; break;
      case 'list_splat_pattern': star = '*'; name = c.namedChildren[0]?.text; break;
      case 'dictionary_splat_pattern': star = '**'; name = c.namedChildren[0]?.text; break;
      case 'positional_separator':
        for (const p of out) if (p.kind === 'normal') p.kind = 'posonly';
        continue;
      case 'keyword_separator': kwOnly = true; continue;
      default: continue; // comments, py2 tuple patterns
    }
    if (!name) continue;
    let kind = 'normal';
    if (star === '*') { kind = 'vararg'; kwOnly = true; }
    else if (star === '**') kind = 'kwarg';
    else if (kwOnly) kind = 'kwonly';
    out.push({ name, star, type, default: def == null ? null : def.replace(/\s+/g, ' ').trim(), kind });
  }
  return out;
}

function decoratorsOf(defNode) {
  const p = defNode.parent;
  if (!p || p.type !== 'decorated_definition') return [];
  return p.namedChildren.filter((c) => c.type === 'decorator').map((d) => d.text.replace(/^@\s*/, '').trim());
}

const NESTED = new Set(['function_definition', 'class_definition', 'lambda', 'decorated_definition']);

function exceptTypes(node) {
  // the types an `except X as e:` clause catches, for `raise e` and bare `raise`
  for (let p = node.parent; p; p = p.parent) {
    if (NESTED.has(p.type)) return { types: [], alias: null };
    if (p.type === 'except_clause' || p.type === 'except_group_clause') {
      const v = p.namedChildren.find((c) => c.type !== 'block' && c.type !== 'comment');
      if (!v) return { types: [], alias: null };
      let typeNode = v, alias = null;
      if (v.type === 'as_pattern') { typeNode = v.namedChildren[0]; alias = v.childForFieldName('alias')?.text || v.namedChildren[1]?.text || null; }
      const txt = typeNode ? typeNode.text.replace(/^\(|\)$/g, '') : '';
      return { types: splitTop(txt).filter(Boolean), alias };
    }
  }
  return { types: [], alias: null };
}

function bodyFacts(body) {
  const facts = { returnsValue: false, yields: false, raises: [] };
  const add = (n) => { n = n.replace(/\s+/g, ''); if (n && !facts.raises.includes(n)) facts.raises.push(n); };
  const walk = (n) => {
    for (const c of n.namedChildren) {
      if (NESTED.has(c.type)) continue;
      if (c.type === 'return_statement') {
        const v = c.namedChildren.find((x) => x.type !== 'comment');
        if (v && v.type !== 'none') facts.returnsValue = true;
      } else if (c.type === 'yield') facts.yields = true;
      else if (c.type === 'raise_statement') {
        const cause = c.childForFieldName('cause');
        const e = c.namedChildren.find((x) => x.type !== 'comment' && (!cause || x.id !== cause.id));
        if (!e) { for (const t of exceptTypes(c).types) add(t); }
        else {
          const target = e.type === 'call' ? e.childForFieldName('function') : e;
          const name = target ? target.text : '';
          if (target && target.type === 'identifier' && /^[a-z_]/.test(name)) {
            const ex = exceptTypes(c);
            if (ex.alias === name) for (const t of ex.types) add(t);
          } else if (target && (target.type === 'identifier' || target.type === 'attribute')) add(name);
        }
      }
      walk(c);
    }
  };
  if (body) walk(body);
  return facts;
}

function firstStatement(body) {
  if (!body) return null;
  return body.namedChildren.find((c) => c.type !== 'comment') || null;
}

/** The docstring node of a block, or null. */
function docstringNode(body) {
  const s = firstStatement(body);
  if (!s || s.type !== 'expression_statement') return null;
  const v = s.namedChildren[0];
  if (v && v.type === 'string' && s.namedChildren.length === 1) return v;
  if (v && v.type === 'concatenated_string') return v;
  return null;
}

function functionInfo(fn, { isMethod }) {
  const decorators = decoratorsOf(fn);
  const params = parseParams(fn.childForFieldName('parameters'));
  const isStatic = decorators.some((d) => /(^|\.)staticmethod$/.test(d));
  if (isMethod && !isStatic && params.length && params[0].kind !== 'vararg' && params[0].kind !== 'kwarg') params.shift();
  const returnType = normType(fn.childForFieldName('return_type')?.text);
  const body = fn.childForFieldName('body');
  const facts = bodyFacts(body);
  const isAsync = fn.children.some((c) => c.type === 'async');
  const isProperty = decorators.some((d) => /(^|\.)(property|cached_property)$|\.(getter)$/.test(d));
  let returns = null, yields = null;
  if (facts.yields) {
    yields = { type: yieldType(returnType) };
  } else if (returnType && !/^(None|NoReturn|Never|typing\.NoReturn|typing\.Never)$/.test(returnType)) {
    returns = { type: returnType };
  } else if (!returnType && facts.returnsValue) {
    returns = { type: '' };
  }
  return {
    kind: 'function', name: fn.childForFieldName('name')?.text || '', isAsync, isMethod, isProperty, decorators,
    params, returns: isProperty ? null : returns, yields, raises: facts.raises, returnType, attributes: [],
  };
}

function classInfo(cls, opts) {
  const decorators = decoratorsOf(cls);
  const bases = cls.childForFieldName('superclasses');
  const baseText = bases ? bases.text : '';
  const dataLike = decorators.some((d) => DATACLASS_DECOR.test(d.replace(/\(.*$/s, '').trim()) || DATACLASS_DECOR.test(d)) || DATACLASS_BASES.test(baseText);
  const body = cls.childForFieldName('body');
  const attributes = []; const seen = new Set();
  const addAttr = (name, type, def) => { if (!name || seen.has(name) || (opts.skipPrivateAttributes !== false && name.startsWith('_'))) return; seen.add(name); attributes.push({ name, star: '', type: type || '', default: def, kind: 'attr' }); };
  let initParams = [];
  if (body) {
    for (const st of body.namedChildren) {
      if (st.type === 'expression_statement') {
        const a = st.namedChildren[0];
        if (a && a.type === 'assignment' && a.childForFieldName('type')) {
          const left = a.childForFieldName('left');
          const type = normType(a.childForFieldName('type').text);
          if (left && left.type === 'identifier' && !/^(typing\.)?ClassVar\b/.test(type)) addAttr(left.text, type, a.childForFieldName('right')?.text ?? null);
        }
      }
      const def = st.type === 'decorated_definition' ? st.childForFieldName('definition') : st;
      if (def && def.type === 'function_definition' && def.childForFieldName('name')?.text === '__init__') {
        initParams = parseParams(def.childForFieldName('parameters'));
        if (initParams.length && initParams[0].kind === 'normal') initParams.shift();
        const byName = new Map(initParams.map((p) => [p.name, p]));
        const walk = (n) => {
          for (const c of n.namedChildren) {
            if (NESTED.has(c.type)) continue;
            if (c.type === 'assignment') {
              const left = c.childForFieldName('left');
              if (left && left.type === 'attribute' && left.childForFieldName('object')?.text === 'self') {
                const nm = left.childForFieldName('attribute')?.text;
                let type = normType(c.childForFieldName('type')?.text);
                const right = c.childForFieldName('right');
                if (!type && right && right.type === 'identifier' && byName.has(right.text)) type = byName.get(right.text).type;
                addAttr(nm, type, null);
              }
            }
            walk(c);
          }
        };
        walk(def.childForFieldName('body'));
      }
    }
  }
  const useInit = !dataLike && opts.classInitArgs !== 'init';
  return {
    kind: 'class', name: cls.childForFieldName('name')?.text || '', decorators, bases: baseText, dataLike,
    params: useInit ? initParams : [], returns: null, yields: null, raises: [], attributes, returnType: '',
  };
}

function findDefAtRow(root, row) {
  let best = null;
  const visit = (n) => {
    if (n.startPosition.row > row || n.endPosition.row < row) return;
    if ((n.type === 'function_definition' || n.type === 'class_definition') && n.startPosition.row === row) { best = n; return; }
    for (const c of n.namedChildren) { visit(c); if (best) return; }
  };
  visit(root);
  return best;
}

function isMethodAt(src, k) {
  const ind = scan.width(scan.indentOf(src.line(k)));
  if (ind === 0) return false;
  for (let i = k - 1; i >= 0 && i >= k - 20000; i--) {
    const t = src.line(i);
    if (scan.isBlank(t) || scan.isComment(t)) continue;
    const w = scan.width(scan.indentOf(t));
    if (w < ind) {
      if (/^\s*(async\s+)?def\b/.test(t)) return false;
      if (/^\s*class\b/.test(t)) return true;
      if (/^\s*@/.test(t)) continue;
      // a deeper-indented continuation line (a long signature) or a statement: keep looking only for headers
      if (/^\s*[)\]}]/.test(t)) continue;
      return false;
    }
  }
  return false;
}

// Text taken from the code (defaults, types, exception names) goes inside a docstring literal. Escape backslashes
// and triple quotes so the docstring stays valid Python and its runtime value shows the source text.
function docSafe(t) {
  if (t == null || typeof t !== 'string') return t;
  return t.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"').replace(/'''/g, "\\'\\'\\'");
}
function safeInfo(info) {
  if (!info) return info;
  const fix = (p) => (p ? { ...p, default: docSafe(p.default), type: docSafe(p.type) } : p);
  return {
    ...info,
    params: (info.params || []).map(fix),
    attributes: (info.attributes || []).map(fix),
    raises: (info.raises || []).map(docSafe),
    returns: info.returns ? { ...info.returns, type: docSafe(info.returns.type) } : info.returns,
    yields: info.yields ? { ...info.yields, type: docSafe(info.yields.type) } : info.yields,
  };
}

/**
 * Analyse the def/class for a docstring at line L.
 * mode 'below': L is the line right under the header (where `"""` was typed). triggerLine: that line's text is ignored.
 * mode 'enclosing': the def/class around the cursor line L.
 * Returns { kind, info, headerStart, headerEnd, insertLine, bodyIndent, doc } or { error }.
 */
async function analyze(src, L, { mode = 'enclosing', indentUnit = '    ', classInitArgs = 'class', skipPrivateAttributes = true } = {}) {
  const trig = mode === 'below' ? L : -1;
  let h = mode === 'below' ? scan.headerAbove(src, L) : scan.enclosing(src, L);
  if (!h) {
    if (mode === 'below' && scan.isModuleTop(src, L)) return { kind: 'module', info: { kind: 'module', params: [], attributes: [], raises: [] }, insertLine: L, bodyIndent: '', doc: null };
    const lt = src.line(L) || '', prev = L > 0 ? src.line(L - 1) : '';
    if (/\blambda\b/.test(lt) || /\blambda\b/.test(prev)) return { error: 'lambda' };
    if (mode === 'enclosing' && scan.isModuleTop(src, L)) return { error: 'nodef' };
    const near = L > 0 && scan.enclosing(src, L - 1);
    if (near && near.inline) return { error: 'inline' };
    return { error: 'nodef' };
  }
  if (h.inline) return { error: 'inline' };
  const ds = scan.decoratorStart(src, h.start);
  // the line typed on, and a closing quote line that auto-close or Enter left under it, are not body lines
  const skip = new Set();
  if (trig >= 0) {
    skip.add(trig);
    if (trig + 1 < src.count && /^[ \t]*("""|''')[ \t]*$/.test(src.line(trig + 1))) skip.add(trig + 1);
  }
  const be = scan.blockEnd(src, h.start, h.end, skip);
  const hdrInd = scan.indentOf(src.line(h.start));
  // the body indent: the first real body line, else the typed line, else header + one unit (rival issue #315)
  let bodyIndent = null;
  for (let i = h.end + 1; i < Math.min(be, h.end + 400); i++) {
    if (skip.has(i)) continue;
    const t = src.line(i);
    if (scan.isBlank(t) || scan.isComment(t)) continue;
    const ind = scan.indentOf(t);
    if (scan.width(ind) > scan.width(hdrInd)) bodyIndent = ind;
    break;
  }
  if (bodyIndent == null && trig >= 0) {
    const ind = scan.indentOf(src.line(trig));
    if (scan.width(ind) > scan.width(hdrInd)) bodyIndent = ind;
  }
  if (bodyIndent == null) bodyIndent = hdrInd + (hdrInd.includes('\t') ? '\t' : indentUnit);

  const lines = [];
  const end = Math.max(be, trig + 1, h.end + 1);
  let hasBody = false;
  for (let i = ds; i < end && i < src.count; i++) {
    if (i === trig) { lines.push(bodyIndent + 'pass'); hasBody = true; continue; }
    if (skip.has(i)) { lines.push(''); continue; }
    const t = src.line(i);
    if (i > h.end && !scan.isBlank(t) && !scan.isComment(t)) hasBody = true;
    lines.push(t);
  }
  if (!hasBody) lines.push(bodyIndent + 'pass');
  const shift = hdrInd.length ? 1 : 0;
  const text = (shift ? 'if 1:\n' : '') + lines.join('\n') + '\n';
  const isMethod = isMethodAt(src, ds);
  const opts = { isMethod, classInitArgs, skipPrivateAttributes };
  const res = await ts.withTree('python', text, (root) => {
    const node = findDefAtRow(root, h.start - ds + shift);
    if (!node) return { error: 'syntax', errorRow: firstErrorRow(root, ds - shift) };
    const info = safeInfo(node.type === 'class_definition' ? classInfo(node, opts) : functionInfo(node, opts));
    const paramsNode = node.childForFieldName('parameters');
    if (paramsNode && paramsNode.hasError) info.partial = true;
    let doc = null;
    if (trig < 0) {
      const d = docstringNode(node.childForFieldName('body'));
      if (d) doc = docInfo(d, ds - shift);
    }
    return { info, doc };
  });
  if (res.error) return { error: res.error, errorRow: res.errorRow };
  return { kind: res.info.kind, info: res.info, doc: res.doc, headerStart: h.start, headerEnd: h.end, decoratorStart: ds, insertLine: h.end + 1, bodyIndent, blockEnd: be };
}

function firstErrorRow(root, offset) {
  let row = null;
  const v = (n) => { if (row != null) return; if (n.type === 'ERROR' || n.isMissing) { row = n.startPosition.row + offset; return; } for (const c of n.children) v(c); };
  v(root);
  return row;
}

function docInfo(node, rowOffset) {
  const t = node.text;
  const m = /^([rRuUbBfF]{0,2})("""|'''|"|')/.exec(t);
  const prefix = m ? m[1] : '', quote = m ? m[2] : '"""';
  const inner = t.slice(prefix.length + quote.length, t.length - quote.length);
  return {
    startRow: node.startPosition.row + rowOffset, startCol: node.startPosition.column,
    endRow: node.endPosition.row + rowOffset, endCol: node.endPosition.column,
    prefix, quote, inner, concatenated: node.type === 'concatenated_string',
  };
}

/** Every def and class in a whole file (for "update all" and coverage). Parses the full file once. */
async function analyzeFile(text, { classInitArgs = 'class', skipPrivateAttributes = true } = {}) {
  return ts.withTree('python', text, (root) => {
    const out = [];
    const visit = (n, inClass) => {
      for (const c of n.namedChildren) {
        const def = c.type === 'decorated_definition' ? c.childForFieldName('definition') : c;
        if (def && (def.type === 'function_definition' || def.type === 'class_definition')) {
          const isClass = def.type === 'class_definition';
          const info = safeInfo(isClass ? classInfo(def, { classInitArgs, skipPrivateAttributes }) : functionInfo(def, { isMethod: inClass }));
          const body = def.childForFieldName('body');
          const d = docstringNode(body);
          const first = firstStatement(body);
          const colon = def.children.find((x) => x.type === ':');
          const headerEnd = colon ? colon.startPosition.row : def.startPosition.row;
          out.push({
            kind: info.kind, info, doc: d ? docInfo(d, 0) : null,
            headerStart: def.startPosition.row, decoratorStart: c.startPosition.row, headerEnd,
            inline: !!(first && first.startPosition.row === headerEnd),
            firstRow: first ? first.startPosition.row : null, name: info.name,
            hasError: def.hasError,
          });
          if (body) visit(body, isClass);
        } else if (c.type !== 'string' && c.namedChildCount && !NESTED.has(c.type)) visit(c, inClass && c.type === 'block');
      }
    };
    visit(root, false);
    return out;
  });
}

module.exports = { analyze, analyzeFile, docSafe, parseParams, normType, yieldType, splitTop, isMethodAt, strip };
