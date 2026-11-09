'use strict';
// Renders a docstring in Google, NumPy, Sphinx (reST) or Epytext style, or from a custom template.
// Placeholders are wrapped in \u0001...\u0002 so the same text becomes a VS Code snippet (tab stops) or plain text.

const O = '\u0001', C = '\u0002';
const ph = (t) => O + t + C;

const TEXT = {
  summary: 'Summary.',
  extended: 'Extended description.',
  param: (n) => `Description of ${n}.`,
  attr: (n) => `Description of ${n}.`,
  returns: 'Description of the return value.',
  yields: 'Description of the yielded values.',
  raises: 'Raised when ...',
  type: 'type',
};

const PLACEHOLDER_RE = /^(?:Description of [^\s,]+\.?|Description of the return value\.|Description of the yielded values\.|Raised when \.\.\.|Summary\.|Extended description\.|_summary_|_description_|_type_|\[summary\]|\[description\]|\[type\]|TODO)?\s*(?:,?\s*[Dd]efaults? (?:to|is) .*|\bdefault .*)?$/;
/** True when a description is empty or still one of our (or a common) placeholders. */
function isPlaceholder(desc) {
  const d = String(desc || '').replace(/^\[removed from the signature\]\s*/, '').trim();
  return PLACEHOLDER_RE.test(d);
}

function escSnippet(s) { return s.replace(/[\\$}]/g, '\\$&'); }
function toSnippet(s) {
  let n = 0;
  return s.split(/(\u0001[^\u0002]*\u0002)/).map((part) => part.startsWith(O) ? '${' + (++n) + ':' + escSnippet(part.slice(1, -1)) + '}' : escSnippet(part)).join('');
}
function toText(s) { return s.replace(/[\u0001\u0002]/g, ''); }

function display(p) { return (p.star || '') + p.name; }

function typeOf(p, o) {
  if (o.includeTypes === 'never') return '';
  if (p.type) return p.type;
  return o.includeTypes === 'always' ? ph(TEXT.type) : '';
}
function retType(t, o, force) {
  if (o.includeTypes === 'never' && !force) return '';
  if (t) return t;
  return o.includeTypes === 'always' || force ? ph(TEXT.type) : '';
}

const hasDefault = (p, o) => o.includeDefaults !== false && p.default != null;

// ---- one entry per style (also used by the updater for new parameters) ----

function googleParam(p, o, unit) {
  const t = typeOf(p, o);
  const opt = hasDefault(p, o) && o.optionalMarker !== false && p.kind !== 'attr';
  let head = display(p);
  if (t) head += ` (${t}${opt ? ', optional' : ''})`;
  else if (opt) head += ' (optional)';
  const desc = ph(p.kind === 'attr' ? TEXT.attr(p.name) : TEXT.param(p.name));
  return [`${unit}${head}: ${desc}${hasDefault(p, o) ? ` Defaults to ${p.default}.` : ''}`];
}
function numpyParam(p, o, unit) {
  const t = typeOf(p, o);
  let head = display(p);
  const bits = [];
  if (t) bits.push(t);
  if (hasDefault(p, o)) bits.push(`default ${p.default}`);
  if (bits.length) head += ' : ' + bits.join(', ');
  return [head, unit + ph(p.kind === 'attr' ? TEXT.attr(p.name) : TEXT.param(p.name))];
}
function fieldParam(p, o, style) {
  const t = typeOf(p, o);
  const def = hasDefault(p, o) ? `, defaults to ${p.default}.` : '';
  const attr = p.kind === 'attr';
  const d0 = attr ? TEXT.attr(p.name) : TEXT.param(p.name);
  const desc = ph(def ? d0.replace(/\.$/, '') : d0);
  if (style === 'sphinx') {
    const out = [`:${attr ? 'ivar' : 'param'} ${p.name}: ${desc}${def}`];
    if (t) out.push(`:${attr ? 'vartype' : 'type'} ${p.name}: ${t}${hasDefault(p, o) && !attr ? ', optional' : ''}`);
    return out;
  }
  const out = [`@${attr ? 'ivar' : 'param'} ${p.name}: ${desc}${def}`];
  if (t) out.push(`@type ${p.name}: ${t}`);
  return out;
}

function sectionLines(kind, items, info, o) {
  const unit = o.docIndent || '    ';
  const s = o.style;
  if (s === 'google') {
    switch (kind) {
      case 'params': return ['Args:', ...items.flatMap((p) => googleParam(p, o, unit))];
      case 'attributes': return ['Attributes:', ...items.flatMap((p) => googleParam(p, o, unit))];
      case 'returns': { const t = retType(items.type, o); return ['Returns:', `${unit}${t ? t + ': ' : ''}${ph(TEXT.returns)}`]; }
      case 'yields': { const t = retType(items.type, o); return ['Yields:', `${unit}${t ? t + ': ' : ''}${ph(TEXT.yields)}`]; }
      case 'raises': return ['Raises:', ...items.map((e) => `${unit}${e}: ${ph(TEXT.raises)}`)];
    }
  }
  if (s === 'numpy') {
    const head = (t) => [t, '-'.repeat(t.length)];
    switch (kind) {
      case 'params': return [...head('Parameters'), ...items.flatMap((p) => numpyParam(p, o, unit))];
      case 'attributes': return [...head('Attributes'), ...items.flatMap((p) => numpyParam(p, o, unit))];
      case 'returns': return [...head('Returns'), retType(items.type, o, true), unit + ph(TEXT.returns)];
      case 'yields': return [...head('Yields'), retType(items.type, o, true), unit + ph(TEXT.yields)];
      case 'raises': return [...head('Raises'), ...items.flatMap((e) => [e, unit + ph(TEXT.raises)])];
    }
  }
  if (s === 'sphinx') {
    switch (kind) {
      case 'params': case 'attributes': return items.flatMap((p) => fieldParam(p, o, 'sphinx'));
      case 'returns': { const t = retType(items.type, o); return [`:return: ${ph(TEXT.returns)}`, ...(t ? [`:rtype: ${t}`] : [])]; }
      case 'yields': { const t = retType(items.type, o); return [`:yield: ${ph(TEXT.yields)}`, ...(t ? [`:ytype: ${t}`] : [])]; }
      case 'raises': return items.map((e) => `:raises ${e}: ${ph(TEXT.raises)}`);
    }
  }
  if (s === 'epytext') {
    switch (kind) {
      case 'params': case 'attributes': return items.flatMap((p) => fieldParam(p, o, 'epytext'));
      case 'returns': { const t = retType(items.type, o); return [`@return: ${ph(TEXT.returns)}`, ...(t ? [`@rtype: ${t}`] : [])]; }
      case 'yields': { const t = retType(items.type, o); return [`@return: ${ph(TEXT.yields)}`, ...(t ? [`@rtype: ${t}`] : [])]; }
      case 'raises': return items.map((e) => `@raise ${e}: ${ph(TEXT.raises)}`);
    }
  }
  return [];
}

/** Section order. Field styles (sphinx, epytext) put fields together without blank lines. */
function bodyLines(info, o) {
  const parts = [];
  const attrs = info.attributes || [];
  if (info.params && info.params.length) parts.push(sectionLines('params', info.params, info, o));
  if (attrs.length) parts.push(sectionLines('attributes', attrs.map((a) => ({ ...a, kind: 'attr' })), info, o));
  if (info.returns) parts.push(sectionLines('returns', info.returns, info, o));
  if (info.yields) parts.push(sectionLines('yields', info.yields, info, o));
  if (info.raises && info.raises.length) parts.push(sectionLines('raises', info.raises, info, o));
  const field = o.style === 'sphinx' || o.style === 'epytext';
  const out = [];
  parts.forEach((p, i) => { if (i && !field) out.push(''); out.push(...p); });
  return out;
}

/** Content lines of the docstring (without quotes or the outer indent). */
function contentLines(info, o) {
  if (o.style === 'custom' && o.template) return templateLines(info, o);
  const lines = [ph(TEXT.summary)];
  if (o.includeExtendedSummary) lines.push('', ph(TEXT.extended));
  const body = info.kind === 'module' ? [] : bodyLines(info, o);
  if (body.length) lines.push('', ...body);
  return lines;
}

/** The full docstring text, indented with `indent`, with the opening and closing quotes. */
function renderDocstring(info, o, indent) {
  const q = o.quote || '"""';
  let lines = contentLines(info, o);
  const single = lines.length === 1 && !o.summaryOnNewLine && !o.alwaysMultiline;
  if (single) return { text: indent + q + lines[0] + q, lines: 1 };
  if (o.summaryOnNewLine) lines = ['', ...lines];
  if (o.blankLineAfterLastSection && lines.length > 1) lines.push('');
  const out = [indent + q + lines[0]];
  for (let i = 1; i < lines.length; i++) out.push(lines[i] ? indent + lines[i] : '');
  out.push(indent + q);
  return { text: out.join('\n'), lines: out.length };
}

// ---- custom templates: a small Mustache subset ({{var}}, {{&var}}, {{#list}}, {{^list}}, {{! comment}}) ----

function templateContext(info, o) {
  const P = (p) => {
    const t = p.type || '';
    return {
      var: display(p), name: p.name, type: t, typePlaceholder: t || ph(TEXT.type), default: p.default == null ? '' : p.default,
      descriptionPlaceholder: ph(p.kind === 'attr' ? TEXT.attr(p.name) : TEXT.param(p.name)), kind: p.kind,
    };
  };
  const params = (info.params || []).map(P);
  const args = (info.params || []).filter((p) => p.default == null).map(P);
  const kwargs = (info.params || []).filter((p) => p.default != null).map(P);
  const exceptions = (info.raises || []).map((e) => ({ type: e, var: e, descriptionPlaceholder: ph(TEXT.raises) }));
  const R = (x, text) => x ? [{ type: x.type || '', typePlaceholder: x.type || ph(TEXT.type), descriptionPlaceholder: ph(text) }] : [];
  const returns = R(info.returns, TEXT.returns), yields = R(info.yields, TEXT.yields);
  const attributes = (info.attributes || []).map((a) => P({ ...a, kind: 'attr' }));
  return {
    name: info.name || '', kind: info.kind, summaryPlaceholder: ph(TEXT.summary), extendedSummaryPlaceholder: ph(TEXT.extended),
    params, args, kwargs, exceptions, returns, yields, attributes,
    parametersExist: params.length > 0, argsExist: args.length > 0, kwargsExist: kwargs.length > 0, exceptionsExist: exceptions.length > 0,
    returnsExist: returns.length > 0, yieldsExist: yields.length > 0, attributesExist: attributes.length > 0,
  };
}

function renderTemplate(tpl, ctx) {
  // standalone section and comment tags take their whole line with them
  tpl = tpl.replace(/^[ \t]*(\{\{[#^/!][^}]*\}\})[ \t]*\r?\n/gm, '$1');
  const lookup = (stack, name) => {
    for (let i = stack.length - 1; i >= 0; i--) { const s = stack[i]; if (s && typeof s === 'object' && name in s) return s[name]; }
    return undefined;
  };
  const render = (t, stack, depth) => {
    if (depth > 20) return '';
    let out = '', i = 0;
    while (i < t.length) {
      const a = t.indexOf('{{', i);
      if (a < 0) { out += t.slice(i); break; }
      out += t.slice(i, a);
      const b = t.indexOf('}}', a);
      if (b < 0) { out += t.slice(a); break; }
      const tag = t.slice(a + 2, b).trim();
      i = b + 2;
      const kind = tag[0];
      if (kind === '!') continue;
      if (kind === '#' || kind === '^') {
        const name = tag.slice(1).trim();
        // find the matching close tag, counting nested sections of the same name
        let depthN = 1, j = i, close = -1, closeEnd = -1;
        const re = /\{\{\s*([#^/])\s*([^}]+?)\s*\}\}/g; re.lastIndex = i;
        let m;
        while ((m = re.exec(t))) {
          if (m[2] !== name) continue;
          if (m[1] === '/') { depthN--; if (!depthN) { close = m.index; closeEnd = re.lastIndex; break; } } else depthN++;
        }
        if (close < 0) { j = t.length; close = j; closeEnd = j; }
        const inner = t.slice(i, close);
        const v = lookup(stack, name);
        const truthy = Array.isArray(v) ? v.length > 0 : !!v;
        if (kind === '^') { if (!truthy) out += render(inner, stack, depth + 1); }
        else if (Array.isArray(v)) for (const item of v) out += render(inner, [...stack, item], depth + 1);
        else if (truthy) out += render(inner, typeof v === 'object' ? [...stack, v] : stack, depth + 1);
        i = closeEnd;
        continue;
      }
      if (kind === '/') continue;
      const name = kind === '&' || kind === '{' ? tag.slice(1).replace(/}$/, '').trim() : tag;
      const v = lookup(stack, name);
      if (v != null && v !== false) out += String(v);
      if (kind === '{' && t[i] === '}') i++;
    }
    return out;
  };
  return render(tpl, [ctx], 0);
}

function templateLines(info, o) {
  const text = renderTemplate(o.template, templateContext(info, o));
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  // drop blank lines that missing sections leave behind
  const out = [];
  for (const l of lines) { if (!l && (!out.length || !out[out.length - 1])) continue; out.push(l); }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.length ? out : [ph(TEXT.summary)];
}

module.exports = { ph, toSnippet, toText, renderDocstring, contentLines, sectionLines, googleParam, numpyParam, fieldParam, renderTemplate, templateContext, isPlaceholder, TEXT, display };
