'use strict';
// JSDoc for JavaScript and TypeScript: @param with the TypeScript types (or types guessed from JS defaults),
// optional and default values, @returns, @throws, @yields and @template. Also updates an existing JSDoc block
// after the signature changed, keeping the text the user wrote.
const ts = require('./ts');
const R = require('./render');

const FN_TYPES = new Set(['function_declaration', 'generator_function_declaration', 'method_definition', 'function_expression',
  'arrow_function', 'generator_function', 'function', 'method_signature', 'abstract_method_signature', 'function_signature', 'class_declaration', 'abstract_class_declaration', 'class']);
const WRAPPERS = new Set(['export_statement', 'lexical_declaration', 'variable_declaration', 'variable_declarator', 'expression_statement',
  'assignment_expression', 'pair', 'public_field_definition', 'field_definition', 'property_signature']);
const NESTED = new Set(['function_declaration', 'generator_function_declaration', 'function_expression', 'arrow_function', 'generator_function', 'function', 'method_definition', 'class_declaration', 'class']);
const MARK = '[removed from the signature]';

function langFor(languageId) { return languageId === 'typescript' ? 'typescript' : 'tsx'; }
function norm(t) { return (t || '').replace(/\s+/g, ' ').replace(/^:\s*/, '').trim(); }

function guessType(v) {
  if (!v) return '';
  switch (v.type) {
    case 'number': return 'number';
    case 'string': case 'template_string': return 'string';
    case 'true': case 'false': return 'boolean';
    case 'array': return 'Array';
    case 'object': return 'Object';
    case 'arrow_function': case 'function_expression': case 'function': return 'Function';
    case 'null': return 'null';
    case 'regex': return 'RegExp';
    case 'new_expression': return v.childForFieldName('constructor')?.text || '';
    default: return '';
  }
}

function params(fnNode, isTs) {
  const list = fnNode.childForFieldName('parameters') || (fnNode.type === 'arrow_function' && fnNode.childForFieldName('parameter'));
  const out = [];
  if (!list) return out;
  const items = list.type === 'identifier' ? [list] : list.namedChildren;
  let idx = 0;
  for (const c of items) {
    if (c.type === 'comment' || c.type === 'decorator') continue;
    let pat = c, type = '', def = null, optional = false;
    if (c.type === 'required_parameter' || c.type === 'optional_parameter') {
      pat = c.childForFieldName('pattern') || c.namedChildren.find((x) => x.type !== 'accessibility_modifier' && x.type !== 'override_modifier' && x.type !== 'readonly');
      type = norm(c.childForFieldName('type')?.text);
      const v = c.childForFieldName('value');
      if (v) def = v.text;
      optional = c.type === 'optional_parameter';
      if (!type && v) type = guessType(v);
    } else if (c.type === 'assignment_pattern') {
      pat = c.childForFieldName('left'); const v = c.childForFieldName('right'); def = v ? v.text : null; type = guessType(v);
    }
    if (!pat) continue;
    if (pat.type === 'this') continue;
    let name, rest = false, props = [];
    if (pat.type === 'identifier') name = pat.text;
    else if (pat.type === 'rest_pattern') { rest = true; name = pat.namedChildren[0]?.text || 'args'; if (type.endsWith('[]')) type = type.slice(0, -2); else if (/^Array<(.*)>$/.test(type)) type = type.replace(/^Array<(.*)>$/, '$1'); }
    else if (pat.type === 'object_pattern') {
      name = 'param' + idx; if (!type) type = 'Object';
      for (const p of pat.namedChildren) {
        if (p.type === 'shorthand_property_identifier_pattern') props.push({ name: p.text });
        else if (p.type === 'object_assignment_pattern') { const l = p.childForFieldName('left'); props.push({ name: l?.text, default: p.childForFieldName('right')?.text, type: guessType(p.childForFieldName('right')) }); }
        else if (p.type === 'pair_pattern') props.push({ name: p.childForFieldName('key')?.text });
      }
    } else if (pat.type === 'array_pattern') { name = 'param' + idx; if (!type) type = 'Array'; }
    else name = pat.text;
    if (def != null) def = def.replace(/\s+/g, ' ');
    out.push({ name, type, default: def, optional: optional || def != null, rest, props });
    idx++;
  }
  return out;
}

function bodyFacts(fn) {
  const body = fn.childForFieldName('body');
  const f = { returnsValue: false, yields: false, throws: [] };
  if (!body) return f;
  if (fn.type === 'arrow_function' && body.type !== 'statement_block') { f.returnsValue = true; return f; }
  const walk = (n) => {
    for (const c of n.namedChildren) {
      if (NESTED.has(c.type)) continue;
      if (c.type === 'return_statement' && c.namedChildren.some((x) => x.type !== 'comment')) f.returnsValue = true;
      if (c.type === 'yield_expression') f.yields = true;
      if (c.type === 'throw_statement') {
        const e = c.namedChildren[0];
        if (e && e.type === 'new_expression') { const k = e.childForFieldName('constructor')?.text; if (k && !f.throws.includes(k)) f.throws.push(k); }
      }
      walk(c);
    }
  };
  walk(body);
  return f;
}

function fnName(fn) {
  const n = fn.childForFieldName('name');
  if (n) return n.text;
  const p = fn.parent;
  if (p && p.type === 'variable_declarator') return p.childForFieldName('name')?.text || '';
  if (p && p.type === 'pair') return p.childForFieldName('key')?.text || '';
  return '';
}

// Text taken from the code goes inside a /** */ block: "*/" in a default (a glob like '**/*.ts') or a type would end
// the comment early and break the file. JSDoc's convention is "*\/".
const cmtSafe = (t) => (t == null || typeof t !== 'string' ? t : t.replace(/\*\//g, '*\\/'));
function safeParam(p) {
  return { ...p, default: cmtSafe(p.default), type: cmtSafe(p.type), props: (p.props || []).map((q) => ({ ...q, default: cmtSafe(q.default), type: cmtSafe(q.type) })) };
}

function info(fn, isTs) {
  const isClass = /class/.test(fn.type);
  const tparams = fn.childForFieldName('type_parameters');
  const templates = tparams ? tparams.namedChildren.filter((x) => x.type === 'type_parameter').map((x) => x.childForFieldName('name')?.text || x.text) : [];
  if (isClass) return { kind: 'class', name: fnName(fn), params: [], templates, returns: null, yields: null, throws: [] };
  const ret = norm(fn.childForFieldName('return_type')?.text);
  const isAsync = fn.children.some((c) => c.type === 'async');
  const isGen = /generator/.test(fn.type) || fn.children.some((c) => c.type === '*');
  const f = bodyFacts(fn);
  const isCtor = fn.type === 'method_definition' && fn.childForFieldName('name')?.text === 'constructor';
  const isSetter = fn.children.some((c) => c.type === 'set');
  let returns = null, yields = null;
  if (isGen || f.yields) {
    const m = /^(?:Async)?(?:Generator|Iterator|IterableIterator|Iterable)<(.*)>$/.exec(ret);
    yields = { type: m ? m[1].split(',')[0].trim() : '' };
  } else if (!isCtor && !isSetter) {
    if (ret && !/^(void|never|undefined|Promise<void>)$/.test(ret)) returns = { type: ret };
    else if (!ret && f.returnsValue) returns = { type: isTs ? '' : isAsync ? 'Promise<*>' : '' };
    else if (!ret && isAsync && !isTs) returns = null;
  }
  return { kind: 'function', name: fnName(fn), params: params(fn, isTs).map(safeParam), templates, returns: returns && { ...returns, type: cmtSafe(returns.type) }, yields: yields && { ...yields, type: cmtSafe(yields.type) }, throws: f.throws, isAsync };
}

function anchorOf(fn) {
  let a = fn;
  while (a.parent && WRAPPERS.has(a.parent.type)) a = a.parent;
  return a;
}

function headerEndRow(fn) {
  const body = fn.childForFieldName('body');
  return body ? body.startPosition.row : fn.endPosition.row;
}

/** Find the function for a JSDoc at `row`: the next function below the cursor (only blank or comment lines between), else the one whose header holds the cursor. */
function findFunction(root, lines, row) {
  const cands = [];
  const visit = (n) => { if (FN_TYPES.has(n.type)) cands.push(n); for (const c of n.namedChildren) visit(c); };
  visit(root);
  let below = null;
  for (const fn of cands) {
    const a = anchorOf(fn);
    const ar = a.startPosition.row;
    if (ar >= row && (!below || ar < anchorOf(below).startPosition.row || (ar === anchorOf(below).startPosition.row && fn.startIndex < below.startIndex))) {
      let ok = true;
      for (let r = row + 1; r < ar; r++) { const t = lines[r] || ''; if (t.trim() && !/^\s*(\/\*\*?|\*|\/\/|@)/.test(t)) { ok = false; break; } }
      const cur = (lines[row] || '').trim();
      if (ar > row && cur && !/^(\/\*\*?|\*\/?|\*.*|\/\/.*)$/.test(cur) && !/\*\/\s*$/.test(cur)) ok = false;
      if (ok) below = fn;
    }
  }
  if (below) return below;
  let inner = null;
  for (const fn of cands) {
    const a = anchorOf(fn);
    if (row >= a.startPosition.row && row <= headerEndRow(fn)) { if (!inner || fn.startIndex >= inner.startIndex) inner = fn; }
  }
  return inner;
}

function jsdocType(t, o) { if (!t) return o.jsUntyped === 'none' ? '' : '{' + R.ph('*') + '} '; return `{${t}} `; }

function paramLines(p, o) {
  const out = [];
  const t = p.type ? `{${p.rest ? '...' : ''}${p.type}} ` : (o.includeTypes === 'never' ? '' : `{${p.rest ? '...' : ''}${R.ph('*')}} `);
  const nm = p.optional ? `[${p.name}${p.default != null && o.includeDefaults !== false ? '=' + p.default : ''}]` : p.name;
  out.push(`@param ${o.includeTypes === 'never' ? '' : t}${nm} - ${R.ph(`Description of ${p.name}.`)}`);
  for (const q of p.props || []) {
    const qt = q.type ? `{${q.type}} ` : (o.includeTypes === 'never' ? '' : `{${R.ph('*')}} `);
    const qn = q.default != null ? `[${p.name}.${q.name}=${q.default}]` : `${p.name}.${q.name}`;
    out.push(`@param ${qt}${qn} - ${R.ph(`Description of ${q.name}.`)}`);
  }
  return out;
}

function tagLines(inf, o) {
  const out = [];
  for (const t of inf.templates || []) out.push(`@template ${t}`);
  for (const p of inf.params) out.push(...paramLines(p, o));
  if (inf.returns) out.push(`@returns ${inf.returns.type ? `{${inf.returns.type}} ` : (o.includeTypes === 'never' ? '' : `{${R.ph('*')}} `)}${R.ph('Description of the return value.')}`);
  if (inf.yields) out.push(`@yields ${inf.yields.type ? `{${inf.yields.type}} ` : ''}${R.ph('Description of the yielded values.')}`);
  for (const e of inf.throws) out.push(`@throws {${e}} ${R.ph('Raised when ...')}`);
  return out;
}

function render(inf, o, indent) {
  const tags = tagLines(inf, o);
  const lines = ['/**', ` * ${R.ph('Summary.')}`];
  if (tags.length) lines.push(' *', ...tags.map((t) => ' * ' + t));
  lines.push(' */');
  return lines.map((l) => indent + l).join('\n');
}

// ---------- update ----------

function similarName(a, b) { a = a.toLowerCase(); b = b.toLowerCase(); if (a.startsWith(b) || b.startsWith(a)) return true; let k = 0; while (k < a.length && a[k] === b[k]) k++; return k >= 3; }

function parseBlock(text) {
  // text is "/** ... */". Returns { lines: content lines without " * " }.
  const inner = text.replace(/^\/\*\*/, '').replace(/\*\/$/, '');
  const raw = inner.split(/\r?\n/);
  return raw.map((l) => l.replace(/^\s*\* ?/, '').replace(/\s+$/, '')).filter((l, i, a) => !(i === 0 && !l.trim()) && !(i === a.length - 1 && !l.trim()));
}

function parseTags(lines) {
  const items = []; let cur = null;
  for (const l of lines) {
    const m = /^@(\w+)\b\s*(.*)$/.exec(l.trim());
    if (m) { cur = { tag: m[1], rest: m[2], lines: [l] }; items.push(cur); continue; }
    if (cur) cur.lines.push(l); else items.push({ tag: null, lines: [l] });
  }
  for (const it of items) {
    if (it.tag === 'param' || it.tag === 'arg' || it.tag === 'argument') {
      const m = /^(\{(?:[^{}]|\{[^{}]*\})*\}\s*)?(\[?)([\w$.]+)(?:=([^\]]*))?\]?\s*(?:-\s*)?(.*)$/.exec(it.rest);
      if (m) { it.type = m[1] ? m[1].trim().slice(1, -1) : null; it.name = m[3]; it.desc = m[5]; it.optional = !!m[2]; }
    }
    if (it.tag === 'returns' || it.tag === 'return' || it.tag === 'throws' || it.tag === 'throw' || it.tag === 'exception' || it.tag === 'yields') {
      const m = /^(\{(?:[^{}]|\{[^{}]*\})*\}\s*)?(.*)$/.exec(it.rest);
      it.type = m && m[1] ? m[1].trim().slice(1, -1) : null; it.desc = m ? m[2] : '';
    }
  }
  return items;
}

function updateBlock(text, inf, o, indent) {
  const lines = parseBlock(text);
  const items = parseTags(lines);
  const pItems = items.filter((x) => x.tag === 'param' || x.tag === 'arg' || x.tag === 'argument');
  const top = pItems.filter((x) => x.name && !x.name.includes('.'));
  const sig = inf.params;
  const notes = [];
  const removed = top.filter((x) => !sig.some((p) => p.name === x.name) && !R.isPlaceholder(x.desc));
  const added = sig.filter((p) => !top.some((x) => x.name === p.name));
  const renames = new Map();
  const single = removed.length === 1 && added.length === 1;
  removed.forEach((x) => { const p = sig[top.indexOf(x)]; if (p && added.includes(p) && !renames.has(p.name) && (single || similarName(x.name, p.name))) renames.set(p.name, x); });
  const hasTypes = pItems.some((x) => x.type);
  const o2 = !hasTypes && pItems.length && o.includeTypes === 'always' ? { ...o, includeTypes: 'hinted' } : o;
  const block = [];
  const used = new Set();
  for (const p of sig) {
    let it = top.find((x) => x.name === p.name), old = p.name;
    if (!it && renames.has(p.name)) { it = renames.get(p.name); old = it.name; notes.push(`renamed ${old} to ${p.name}`); }
    if (it) {
      used.add(it);
      const ty = p.type ? `{${p.rest ? '...' : ''}${p.type}} ` : (it.type ? `{${it.type}} ` : '');
      const nm = p.optional ? `[${p.name}${p.default != null && o.includeDefaults !== false ? '=' + p.default : ''}]` : p.name;
      block.push(`@${it.tag} ${ty}${nm}${it.desc ? ' - ' + it.desc : ''}`, ...it.lines.slice(1));
      for (const sub of pItems.filter((x) => x.name && x.name.startsWith(old + '.'))) { used.add(sub); block.push(...sub.lines.map((l, i) => (i ? l : l.replace(old + '.', p.name + '.')))); }
    } else {
      notes.push(`added ${p.name}`);
      block.push(...paramLines(p, o2).map(R.toText));
    }
  }
  for (const it of top) {
    if (used.has(it)) continue;
    if (R.isPlaceholder(it.desc) || o.removedParameters === 'delete') { notes.push(`removed ${it.name}`); continue; }
    notes.push(`marked ${it.name} as removed`);
    block.push(it.lines[0].includes(MARK) ? it.lines[0] : it.lines[0].replace(/(\s-\s|\s)(?=\S*$|[^-]*$)/, ` - ${MARK} `).replace(` - ${MARK} - `, ` - ${MARK} `), ...it.lines.slice(1));
  }
  for (const it of pItems) if (!used.has(it) && it.name && it.name.includes('.') && !top.some((x) => it.name.startsWith(x.name + '.') && !used.has(x))) used.add(it);
  const out = [];
  let placed = false;
  const firstTag = items.findIndex((x) => x.tag && x.tag !== 'template' && x.tag !== 'description');
  items.forEach((it, i) => {
    if (pItems.includes(it)) { if (!placed) { out.push(...block); placed = true; } return; }
    if (!placed && i === firstTag) { out.push(...block); placed = true; }
    out.push(...it.lines);
  });
  if (!placed && block.length) { if (out.length && out[out.length - 1].trim()) out.push(''); out.push(...block); }
  // returns / throws
  const has = (...t) => items.some((x) => t.includes(x.tag));
  if (inf.returns && !has('returns', 'return')) { out.push(R.toText(tagLines({ params: [], returns: inf.returns, throws: [] }, o2)[0])); notes.push('added @returns'); }
  else if (inf.returns && inf.returns.type) {
    const i = out.findIndex((l) => /^@returns?\b/.test(l.trim()));
    if (i >= 0) out[i] = out[i].replace(/^(\s*@returns?)\s*(\{(?:[^{}]|\{[^{}]*\})*\})?\s*/, `$1 {${inf.returns.type}} `).replace(/\s+$/, '');
  }
  const haveThrows = new Set(items.filter((x) => /^(throws|throw|exception)$/.test(x.tag || '')).map((x) => x.type));
  for (const e of inf.throws) if (!haveThrows.has(e)) { out.push(`@throws {${e}} Raised when ...`); notes.push(`added @throws ${e}`); }
  const body = out.length ? out : ['Summary.'];
  const newText = ['/**', ...body.map((l) => (l ? ' * ' + l : ' *')), ' */'].map((l, i) => (i ? indent + l : l)).join('\n');
  return { text: newText, changed: newText.replace(/\s+/g, ' ') !== text.replace(/\s+/g, ' '), notes };
}

/** The JSDoc comment right above node `a`, or null. */
function jsdocAbove(a) {
  let p = a.previousSibling;
  if (p && p.type === 'comment' && p.text.startsWith('/**') && a.startPosition.row - p.endPosition.row <= 1) return p;
  return null;
}

/**
 * Analyse a JS/TS file at `row` for Generate or Update JSDoc.
 * Returns { info, anchorRow, indent, existing: {startRow,startCol,endRow,endCol,text} | null } or { error }.
 */
async function analyze(text, languageId, row) {
  const isTs = languageId === 'typescript' || languageId === 'typescriptreact';
  const lines = text.split(/\r?\n/);
  return ts.withTree(langFor(languageId), text, (root) => {
    const fn = findFunction(root, lines, row);
    if (!fn) return { error: 'nofunction' };
    const a = anchorOf(fn);
    const inf = info(fn, isTs);
    let lead = a;
    // decorators sit in front of a method or class: put the comment above them
    const c = jsdocAbove(lead);
    const anchorRow = lead.startPosition.row;
    const indent = /^[ \t]*/.exec(lines[anchorRow] || '')[0];
    return {
      info: inf, anchorRow, indent, isTs,
      existing: c ? { startRow: c.startPosition.row, startCol: c.startPosition.column, endRow: c.endPosition.row, endCol: c.endPosition.column, text: c.text } : null,
    };
  });
}

module.exports = { analyze, render, updateBlock, tagLines, parseTags, langFor, MARK };
