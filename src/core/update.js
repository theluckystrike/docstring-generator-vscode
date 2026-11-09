'use strict';
// Updates an existing docstring after the signature changed. It keeps every line the user wrote:
// matched parameters keep their text (a renamed parameter keeps its text too), new parameters get a
// placeholder, removed ones are dropped when they only held a placeholder, otherwise kept and marked.
// Types follow the type hints; Returns/Yields/Raises sections are added when missing. Other text is untouched.
const R = require('./render');

const MARK = '[removed from the signature]';
const NAME = '[\\p{L}\\p{N}_]+';
const GOOGLE_TITLES = {
  args: 'params', arguments: 'params', parameters: 'params', params: 'params',
  'keyword args': 'kwparams', 'keyword arguments': 'kwparams', 'other parameters': 'kwparams', 'other params': 'kwparams',
  returns: 'returns', return: 'returns', yields: 'yields', yield: 'yields',
  raises: 'raises', raise: 'raises', exceptions: 'raises', except: 'raises',
  attributes: 'attributes',
  example: 'other', examples: 'other', note: 'other', notes: 'other', todo: 'other', warning: 'other', warnings: 'other',
  warns: 'other', 'see also': 'other', references: 'other', methods: 'other', receives: 'other',
};
const RANK = { params: 1, kwparams: 2, attributes: 3, returns: 4, yields: 5, raises: 6, other: 9 };

function indentW(s) { return /^[ \t]*/.exec(s)[0].length; }
function blank(s) { return !s || !s.trim(); }
const plain = (lines) => lines.map(R.toText);

function detectStyle(lines, fallback) {
  const body = lines.join('\n');
  if (/^\s*:(param|parameter|arg|argument|key|keyword|type|returns?|rtype|raises?|except|exception|ivar|vartype|yields?|ytype)\b[^:\n]*:/m.test(body)) return 'sphinx';
  if (/^\s*@(param|type|return|rtype|raise|ivar|keyword)\b[^:\n]*:/m.test(body)) return 'epytext';
  for (let i = 0; i + 1 < lines.length; i++) if (/^\s*-{3,}\s*$/.test(lines[i + 1]) && GOOGLE_TITLES[lines[i].trim().toLowerCase()]) return 'numpy';
  for (const l of lines) { const m = /^\s*([A-Za-z][A-Za-z ]*):\s*$/.exec(l); if (m && GOOGLE_TITLES[m[1].toLowerCase()]) return 'google'; }
  return fallback === 'custom' ? 'google' : fallback;
}

// ---------- Google and NumPy ----------

function parseSections(lines, style) {
  const head = [], sections = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let title = null;
    if (indentW(l) === 0 || i === 0) {
      if (style === 'numpy') { if (i + 1 < lines.length && /^\s*-{3,}\s*$/.test(lines[i + 1]) && GOOGLE_TITLES[l.trim().toLowerCase()]) title = l.trim(); }
      else { const m = /^\s*([A-Za-z][A-Za-z ]*):\s*$/.exec(l); if (m && GOOGLE_TITLES[m[1].toLowerCase()]) title = m[1]; }
    }
    if (title) {
      cur = { title, key: GOOGLE_TITLES[title.toLowerCase()], header: style === 'numpy' ? [l, lines[i + 1]] : [l], body: [] };
      sections.push(cur);
      if (style === 'numpy') i++;
      continue;
    }
    (cur ? cur.body : head).push(l);
  }
  // trailing blank lines of each part are separators, not content
  const trim = (arr) => { let n = 0; while (arr.length && blank(arr[arr.length - 1])) { arr.pop(); n++; } return n; };
  trim(head);
  for (const s of sections) trim(s.body);
  return { head, sections };
}

function parseEntries(body, style) {
  const first = body.find((l) => !blank(l));
  const ind = first == null ? (style === 'numpy' ? 0 : 4) : indentW(first);
  const pre = [], entries = [];
  let cur = null;
  for (const l of body) {
    if (!blank(l) && indentW(l) === ind) { cur = { lines: [l], ind: l.slice(0, ind) }; entries.push(cur); continue; }
    if (cur) cur.lines.push(l); else pre.push(l);
  }
  for (const e of entries) parseEntryHead(e, style);
  return { pre, entries, ind: first == null ? null : first.slice(0, ind) };
}

function parseEntryHead(e, style) {
  const h = e.lines[0].trim();
  if (style === 'numpy') {
    const m = new RegExp(`^((?:\\*{0,2}${NAME})(?:\\s*,\\s*\\*{0,2}${NAME})*)\\s*(?::\\s*(.*))?$`, 'u').exec(h);
    if (m) { e.names = m[1].split(',').map((x) => x.trim().replace(/^\*+/, '')); e.type = (m[2] || '').trim(); e.rest = ''; }
    else { e.names = []; e.type = h; }
    return;
  }
  const m = new RegExp(`^(\\*{0,2})(${NAME})(?:\\s*\\((.*?)\\))?\\s*:(?:\\s+|$)(.*)$`, 'u').exec(h);
  if (m) { e.names = [m[2]]; e.type = (m[3] || '').trim(); e.rest = m[4] || ''; e.hasParens = m[3] != null; }
  else { e.names = []; e.rest = h; }
}

function splitTopCommas(s) {
  const out = []; let d = 0, cur = '';
  for (const c of s) { if ('[({'.includes(c)) d++; if ('])}'.includes(c)) d--; if (c === ',' && !d) { out.push(cur.trim()); cur = ''; } else cur += c; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function newType(p, oldType, o, style) {
  // returns the type text for a rewritten entry, or null for "no type"
  const parts = oldType ? splitTopCommas(oldType) : [];
  const isMod = (x) => /^(optional|default\b.*|keyword-only|positional-only)$/i.test(x);
  let base = parts.filter((x) => !isMod(x)).join(', ');
  const mods = parts.filter(isMod).filter((x) => !/^(optional|default\b.*)$/i.test(x));
  if (p.type && o.includeTypes !== 'never') base = p.type;
  if (style === 'numpy') {
    if (p.default != null && o.includeDefaults !== false) mods.push(`default ${p.default}`);
  } else if (p.default != null && o.includeDefaults !== false && o.optionalMarker !== false && p.kind !== 'attr' && (base || oldType)) mods.push('optional');
  const all = [base, ...mods].filter(Boolean);
  return all.length ? all.join(', ') : null;
}

function fixDefaultsText(text, p) {
  if (p.default == null) return text.replace(/\s*Defaults to .*?\.(?=\s|$)/, '');
  return text.replace(/Defaults to (.*?)\.(?=\s|$)/, () => `Defaults to ${p.default}.`); // a function: '$1' or '$&' in a default stays literal
}

function rewriteEntry(e, p, o, style, unit) {
  const out = e.lines.slice();
  if (style === 'numpy') {
    if (e.names.length > 1) return out; // "x1, x2 : int": leave as written
    const t = newType(p, e.type, o, 'numpy');
    out[0] = e.ind + R.display(p) + (t ? ' : ' + t : '');
    return out;
  }
  const t = e.hasParens || p.type ? newType(p, e.type, o, 'google') : null;
  const rest = fixDefaultsText(e.rest, p);
  out[0] = e.ind + R.display(p) + (t ? ` (${t})` : '') + ':' + (rest ? ' ' + rest : '');
  return out;
}

function markEntry(e, style) {
  const out = e.lines.slice();
  if (style === 'numpy') {
    const i = out.findIndex((l, k) => k > 0 && !blank(l));
    if (i > 0) out[i] = out[i].replace(/^(\s*)/, `$1${MARK} `); else out.push(e.ind + '    ' + MARK);
  } else if (!out[0].includes(MARK)) out[0] = out[0].replace(/:(\s+|$)/, `: ${MARK} `).replace(/\s+$/, '');
  return out;
}

function entryText(e) { return e.lines.slice(0).join(' ').replace(/^[^:]*:/, ''); }
function entryIsPlaceholder(e, style) {
  if (style === 'numpy') return R.isPlaceholder(e.lines.slice(1).join(' ').trim());
  return R.isPlaceholder([e.rest, ...e.lines.slice(1).map((l) => l.trim())].join(' ').trim());
}

function similar(a, b) {
  a = a.toLowerCase().replace(/^_+/, ''); b = b.toLowerCase().replace(/^_+/, '');
  if (!a || !b) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
  if (k >= 3) return true;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length] <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 3));
}
/**
 * Pair removed entries with added parameters when it looks like a rename: the same position, and either the
 * only change (one removed, one added) or a similar name (a -> alpha, k -> key). The same type alone is not enough.
 */
function pairByPosition(removed, added, indexOfOld, sig, nameOf = (e) => e.names[0], typeOf = (e) => e.type) {
  const pairs = new Map();
  const single = removed.length === 1 && added.length === 1;
  const freeAdded = new Set(added.map((p) => p.name));
  for (const e of removed) {
    const p = sig[indexOfOld(e)];
    if (!p || !freeAdded.has(p.name)) continue;
    if (single || similar(nameOf(e), p.name)) { pairs.set(p.name, e); freeAdded.delete(p.name); }
  }
  return pairs;
}
function pairRenames(entries, sig, docNames, style) {
  const named = entries.filter((e) => e.names.length);
  const removed = named.filter((e) => !e.names.some((n) => sig.some((p) => p.name === n)) && !entryIsPlaceholder(e, style));
  const added = sig.filter((p) => !docNames.has(p.name));
  if (!removed.length || !added.length) return new Map();
  return pairByPosition(removed, added, (e) => named.indexOf(e), sig);
}

function rebuildParamEntries(sec, sig, o, style, notes, opts = {}) {
  const unit = o.docIndent || '    ';
  const { pre, entries, ind } = parseEntries(sec.body, style);
  const docNames = new Set(entries.flatMap((e) => e.names));
  const renames = opts.noRemove ? new Map() : pairRenames(entries, sig, docNames, style);
  const typed = entries.some((e) => (style === 'numpy' ? !!e.type : e.hasParens));
  if (!typed && o.includeTypes === 'always' && entries.length) o = { ...o, includeTypes: 'hinted' };
  const used = new Set();
  const out = [...pre];
  const entryInd = ind != null ? ind : (style === 'numpy' ? '' : unit);
  for (const p of sig) {
    let e = entries.find((x) => x.names.includes(p.name));
    if (!e && renames.has(p.name)) { e = renames.get(p.name); notes.push(`renamed ${e.names[0]} to ${p.name}`); }
    if (e) {
      if (used.has(e)) continue;
      used.add(e);
      out.push(...rewriteEntry(e, p, o, style, unit));
    } else if (!opts.onlyExisting) {
      notes.push(`added ${p.name}`);
      const lines = style === 'numpy' ? R.numpyParam(p, o, unit) : R.googleParam(p, o, '');
      out.push(...plain(lines).map((l, i) => (style === 'numpy' ? (i === 0 ? entryInd + l : entryInd + l) : entryInd + l)));
    }
  }
  for (const e of entries) {
    if (used.has(e)) continue;
    if (!e.names.length) { out.push(...e.lines); continue; }
    if (opts.noRemove) { out.push(...e.lines); continue; }
    if (entryIsPlaceholder(e, style) || o.removedParameters === 'delete') { notes.push(`removed ${e.names.join(', ')}`); continue; }
    notes.push(`marked ${e.names.join(', ')} as removed`);
    out.push(...markEntry(e, style));
  }
  return out;
}

function sectionFor(key, info, o) {
  const lines = plain(R.sectionLines(key === 'kwparams' ? 'params' : key, key === 'params' ? info.params : key === 'attributes' ? info.attributes.map((a) => ({ ...a, kind: 'attr' })) : key === 'returns' ? info.returns : key === 'yields' ? info.yields : info.raises, info, o));
  const hdr = o.style === 'numpy' ? 2 : 1;
  return { title: lines[0], key, header: lines.slice(0, hdr), body: lines.slice(hdr), isNew: true };
}

function updateReturnLike(sec, t, o, style) {
  if (!t || o.includeTypes === 'never') return;
  const i = sec.body.findIndex((l) => !blank(l));
  if (i < 0) return;
  const l = sec.body[i];
  const ind = /^[ \t]*/.exec(l)[0];
  if (style === 'numpy') {
    const m = new RegExp(`^(${NAME})\\s*:\\s*(.+)$`, 'u').exec(l.trim());
    sec.body[i] = ind + (m ? `${m[1]} : ${t}` : t);
    return;
  }
  const m = /^([^\s:][^:]*?):(\s+.*|)$/.exec(l.trim());
  if (m && /^[\w.\[\], |"'()-]+$/.test(m[1]) && !/\s{2}|[a-z]+ [a-z]+ [a-z]+/.test(m[1])) sec.body[i] = ind + t + ':' + m[2];
}

function raisesFromSection(sec, style) {
  const { entries } = parseEntries(sec.body, style);
  return entries.map((e) => (e.lines[0].trim().replace(/:.*$/, '').trim()));
}

function updateSectioned(lines, info, o, style, notes) {
  const o2 = { ...o, style };
  const { head, sections } = parseSections(lines, style);
  if (o.bulk && !sections.length) return lines;
  const has = (k) => sections.find((s) => s.key === k);
  const isClass = info.kind === 'class';
  // parameters (Args / Parameters); keyword sections count as present but are left in place
  const kwSec = has('kwparams');
  const kwNames = kwSec ? new Set(parseEntries(kwSec.body, style).entries.flatMap((e) => e.names)) : new Set();
  const sigMain = info.params.filter((p) => !kwNames.has(p.name));
  const pSec = has('params');
  if (pSec) pSec.body = rebuildParamEntries(pSec, sigMain, o2, style, notes);
  else if (sigMain.length) { const s = sectionFor('params', { ...info, params: sigMain }, o2); sections.push(s); notes.push('added ' + s.title.replace(/:$/, '') + ' section'); }
  if (kwSec) kwSec.body = rebuildParamEntries(kwSec, info.params.filter((p) => kwNames.has(p.name)), o2, style, notes, { onlyExisting: true, noRemove: true });
  if (isClass && info.attributes.length) {
    const aSec = has('attributes');
    if (aSec) aSec.body = rebuildParamEntries(aSec, info.attributes.map((a) => ({ ...a, kind: 'attr' })), o2, style, notes, { noRemove: true });
    else if (!o.bulk) sections.push(sectionFor('attributes', info, o2));
  }
  if (info.returns) { const s = has('returns'); if (s) updateReturnLike(s, info.returns.type, o2, style); else { sections.push(sectionFor('returns', info, o2)); notes.push('added Returns'); } }
  if (info.yields) { const s = has('yields'); if (s) updateReturnLike(s, info.yields.type, o2, style); else { sections.push(sectionFor('yields', info, o2)); notes.push('added Yields'); } }
  if (info.raises.length) {
    const s = has('raises');
    if (s) {
      const known = new Set(raisesFromSection(s, style));
      const miss = info.raises.filter((e) => !known.has(e));
      if (miss.length) {
        const { ind } = parseEntries(s.body, style);
        const add = plain(R.sectionLines('raises', miss, info, o2)).slice(style === 'numpy' ? 2 : 1);
        const base = style === 'numpy' ? '' : (o2.docIndent || '    ');
        s.body.push(...add.map((l) => (ind != null ? ind + l.slice(base.length) : l)));
        notes.push('added ' + miss.join(', ') + ' to Raises');
      }
    } else { sections.push(sectionFor('raises', info, o2)); notes.push('added Raises'); }
  }
  // drop parameter sections that ended up empty; place new sections by rank
  const kept = sections.filter((s) => !(s.key === 'params' && !s.body.some((l) => !blank(l))));
  const ordered = [];
  for (const s of kept.filter((x) => !x.isNew)) ordered.push(s);
  for (const s of kept.filter((x) => x.isNew)) {
    const at = ordered.findIndex((x) => RANK[x.key] > RANK[s.key]);
    if (at < 0) ordered.push(s); else ordered.splice(at, 0, s);
  }
  const out = [...head];
  for (const s of ordered) { if (out.length) out.push(''); out.push(...s.header, ...s.body); }
  return out;
}

// ---------- Sphinx and Epytext ----------

const PARAM_TAGS = new Set(['param', 'parameter', 'arg', 'argument', 'key', 'keyword']);
function parseFields(lines, style) {
  const lead = style === 'sphinx' ? ':' : '@';
  const re = style === 'sphinx' ? /^:([A-Za-z]+)(?:\s+([^:]*?))?:(?:\s|$)/ : /^@([A-Za-z]+)(?:\s+([^:]*?))?:(?:\s|$)/;
  const items = [];
  let cur = null;
  for (const l of lines) {
    const m = indentW(l) === 0 && l.startsWith(lead) ? re.exec(l) : null;
    if (m) { cur = { field: true, tag: m[1].toLowerCase(), arg: (m[2] || '').trim(), lines: [l] }; items.push(cur); continue; }
    if (cur && !blank(l) && indentW(l) > 0) { cur.lines.push(l); continue; }
    cur = null;
    items.push({ field: false, lines: [l] });
  }
  for (const it of items) if (it.field) { const parts = it.arg.split(/\s+/); it.name = (parts[parts.length - 1] || '').replace(/^(\\?\*)+/, ''); it.inlineType = parts.slice(0, -1).join(' '); }
  return items;
}

function fieldDesc(it) { return [it.lines[0].replace(/^[:@][^:]*:\s*/, ''), ...it.lines.slice(1).map((l) => l.trim())].join(' ').trim(); }

function updateFields(lines, info, o, style, notes) {
  const L = style === 'sphinx' ? ':' : '@';
  const items = parseFields(lines, style);
  if (o.bulk && !items.some((x) => x.field)) return lines;
  const isParam = (it) => it.field && PARAM_TAGS.has(it.tag);
  const isType = (it) => it.field && it.tag === 'type';
  const isAttr = (it) => it.field && ['ivar', 'var', 'cvar'].includes(it.tag);
  const params = items.filter(isParam), types = items.filter(isType);
  const sig = info.params;
  const docNames = new Set(params.map((p) => p.name));
  // rename pairing, by position among the parameter fields
  const removed = params.filter((it) => !sig.some((p) => p.name === it.name) && !R.isPlaceholder(fieldDesc(it)));
  const added = sig.filter((p) => !docNames.has(p.name));
  const renames = removed.length && added.length ? pairByPosition(removed, added, (it) => params.indexOf(it), sig, (it) => it.name, (it) => (types.find((x) => x.name === it.name) || {}).arg && fieldDesc(types.find((x) => x.name === it.name))) : new Map();
  if (!types.length && params.length && o.includeTypes === 'always') o = { ...o, includeTypes: 'hinted' };
  const block = [];
  const used = new Set();
  const typeLine = (name, t, tail) => `${L}type ${name}: ${t}${tail || ''}`;
  for (const p of sig) {
    let it = params.find((x) => x.name === p.name), oldName = p.name;
    if (!it && renames.has(p.name)) { it = renames.get(p.name); oldName = it.name; notes.push(`renamed ${oldName} to ${p.name}`); }
    if (it) {
      used.add(it);
      const first = oldName === p.name ? it.lines[0] : it.lines[0].replace(new RegExp(`^([:@]${it.tag}\\s+(?:[^:]*\\s)?)(?:\\\\?\\*){0,2}${escapeRe(oldName)}:`, 'u'), `$1${p.name}:`);
      block.push(first, ...it.lines.slice(1));
      const ty = types.find((x) => x.name === oldName);
      if (ty) used.add(ty);
      if (p.type && o.includeTypes !== 'never') block.push(typeLine(p.name, p.type, style === 'sphinx' && p.default != null && o.includeDefaults !== false ? ', optional' : ''));
      else if (ty) block.push(ty.lines[0].replace(new RegExp(`(type\\s+)${escapeRe(oldName)}:`, 'u'), `$1${p.name}:`), ...ty.lines.slice(1));
    } else {
      notes.push(`added ${p.name}`);
      block.push(...plain(R.fieldParam(p, o, style)));
    }
  }
  for (const it of params) {
    if (used.has(it)) continue;
    const ty = types.find((x) => x.name === it.name);
    if (ty) used.add(ty);
    if (R.isPlaceholder(fieldDesc(it)) || o.removedParameters === 'delete') { notes.push(`removed ${it.name}`); continue; }
    notes.push(`marked ${it.name} as removed`);
    block.push(it.lines[0].includes(MARK) ? it.lines[0] : it.lines[0].replace(/^([:@][^:]*:)\s*/, `$1 ${MARK} `), ...it.lines.slice(1));
    if (ty) block.push(...ty.lines);
  }
  // attribute fields for classes: add the missing ones only
  const attrBlock = [];
  if (info.kind === 'class') {
    const have = new Set(items.filter(isAttr).map((x) => x.name));
    for (const a of info.attributes) if (!have.has(a.name)) attrBlock.push(...plain(R.fieldParam({ ...a, kind: 'attr' }, o, style)));
  }
  // rebuild: replace the param/type fields at the position of the first one
  const out = [];
  let placed = false;
  const firstFieldIdx = items.findIndex((x) => x.field);
  const anchor = items.findIndex((x) => isParam(x) || (isType(x) && sig.some((p) => p.name === x.name || renames.get(p.name)?.name === x.name)));
  items.forEach((it, idx) => {
    const consumed = isParam(it) || (isType(it) && (used.has(it) || params.some((p) => p.name === it.name)));
    if (!placed && (idx === anchor || (anchor < 0 && idx === firstFieldIdx))) { out.push(...block, ...attrBlock); placed = true; }
    if (consumed) return;
    out.push(...it.lines);
  });
  if (!placed && (block.length || attrBlock.length)) {
    while (out.length && blank(out[out.length - 1])) out.pop();
    if (out.length) out.push('');
    out.push(...block, ...attrBlock);
  }
  // returns / yields / raises
  const fieldsNow = parseFields(out, style);
  const hasTag = (...t) => fieldsNow.some((x) => x.field && t.includes(x.tag));
  const appendFields = (newLines, beforeTags) => {
    const fs = parseFields(out, style);
    let at = -1, pos = 0;
    for (const it of fs) { if (it.field && beforeTags.includes(it.tag) && at < 0) at = pos; pos += it.lines.length; }
    if (at < 0) {
      let last = -1; pos = 0;
      for (const it of fs) { pos += it.lines.length; if (it.field) last = pos; }
      at = last >= 0 ? last : out.length;
      if (last < 0) { while (out.length && blank(out[out.length - 1])) out.pop(); if (out.length) out.push(''); at = out.length; }
    }
    out.splice(at, 0, ...newLines);
  };
  const retTags = ['return', 'returns'];
  if (info.returns) {
    if (!hasTag(...retTags)) { appendFields(plain(R.sectionLines('returns', info.returns, info, { ...o, style })), ['raises', 'raise', 'except', 'exception']); notes.push('added return'); }
    else if (info.returns.type && o.includeTypes !== 'never') {
      const i = out.findIndex((l) => new RegExp(`^\\${L}rtype:`).test(l));
      if (i >= 0) out[i] = `${L}rtype: ${info.returns.type}`;
      else { const j = out.findIndex((l) => new RegExp(`^\\${L}returns?:`).test(l)); let k = j + 1; while (k < out.length && indentW(out[k]) > 0 && !blank(out[k])) k++; out.splice(k, 0, `${L}rtype: ${info.returns.type}`); }
    }
  }
  if (info.yields && !hasTag('yield', 'yields') && !(style === 'epytext' && hasTag(...retTags))) {
    appendFields(plain(R.sectionLines('yields', info.yields, info, { ...o, style })), ['raises', 'raise', 'except', 'exception']); notes.push('added yield');
  }
  if (info.raises.length) {
    const have = new Set(parseFields(out, style).filter((x) => x.field && ['raises', 'raise', 'except', 'exception'].includes(x.tag)).map((x) => x.arg.trim()));
    const miss = info.raises.filter((e) => !have.has(e));
    if (miss.length) { appendFields(plain(R.sectionLines('raises', miss, info, { ...o, style })), []); notes.push('added ' + miss.join(', ') + ' to raises'); }
  }
  return out;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * doc: { inner, quote, prefix }, indent: the docstring's indent. Returns { text, changed, notes, style }.
 * text is the full new docstring literal (prefix + quotes + content), with lines after the first indented.
 */
function updateDocstring(doc, info, o, indent) {
  const raw = doc.inner.split(/\r?\n/);
  const closingOwnLine = raw.length > 1 && blank(raw[raw.length - 1]);
  const lines = raw.map((l, i) => (i === 0 ? l.trim() : l.startsWith(indent) ? l.slice(indent.length) : l.replace(/^[ \t]+/, '')));
  if (closingOwnLine) lines.pop();
  const leadingBlank = lines.length > 0 && lines[0] === '';
  const style = detectStyle(lines, o.style);
  const notes = [];
  const content = style === 'sphinx' || style === 'epytext' ? updateFields(lines, info, o, style, notes) : updateSectioned(lines, info, o, style, notes);
  while (content.length > 1 && blank(content[content.length - 1])) content.pop();
  if (leadingBlank && content[0] !== '') content.unshift('');
  const multi = content.length > 1;
  const body = content.map((l, i) => (i === 0 || !l ? l : indent + l)).join('\n');
  const inner = multi ? body + '\n' + indent : (closingOwnLine ? body + '\n' + indent : body);
  const text = doc.prefix + doc.quote + inner + doc.quote;
  const before = doc.prefix + doc.quote + doc.inner + doc.quote;
  return { text, changed: text !== before, notes, style };
}

/** Quick check used by code actions and "update on save": does the docstring miss or carry stale parameters? */
function staleness(doc, info, o, indent) {
  const r = updateDocstring(doc, info, o, indent);
  return { stale: r.changed, notes: r.notes, text: r.text };
}

module.exports = { updateDocstring, staleness, detectStyle, parseSections, parseFields, MARK };
