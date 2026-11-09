'use strict';
// Line scanner for Python source. It finds the def/class header above a line and the end of its block
// without parsing the whole file, so a 10,000-line file costs the same as a small one.
// `src` is { count, line(i) } (a VS Code document or an array of lines).

const HEADER_RE = /^([ \t]*)(?:async[ \t]+)?(?:def|class)\b/;
const DECORATOR_RE = /^([ \t]*)@/;

function fromText(text) {
  const lines = text.split(/\r?\n/);
  return { count: lines.length, line: (i) => lines[i] };
}

function indentOf(s) { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; }
/** Width of an indent with tabs counted as 8 columns (Python's rule for comparing). */
function width(ws) { let w = 0; for (const c of ws) w = c === '\t' ? w + 8 - (w % 8) : w + 1; return w; }
function isBlank(s) { return !s || /^\s*$/.test(s); }
function isComment(s) { return /^\s*#/.test(s); }

/**
 * Scan one line from a state { depth, str } and return the state at its end plus facts about the line.
 * str is null, '"""', "'''" (open triple-quoted string). Single-quoted strings close at the line end.
 * lastCode: the last character outside strings and comments. colonAtDepth0: a ':' seen at depth 0.
 */
function scanLine(text, state) {
  let depth = state.depth, str = state.str, lastCode = '', colon0 = false, colon0End = -1;
  let i = 0; const n = text.length;
  while (i < n) {
    const c = text[i];
    if (str) {
      if (c === '\\') { i += 2; continue; }
      if (text.startsWith(str, i)) { i += str.length; if (str.length === 3) lastCode = '"'; str = null; continue; }
      i++; continue;
    }
    if (c === '#') break;
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c + c + c, i);
      if (triple) { str = c + c + c; i += 3; continue; }
      // single-quoted string: skip to its end on this line
      let j = i + 1;
      while (j < n && text[j] !== c) { if (text[j] === '\\') j++; j++; }
      i = j + 1; lastCode = c; continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0) { colon0 = true; colon0End = i; }
    if (!/\s/.test(c)) lastCode = c;
    i++;
  }
  // backslash continuation keeps the logical line open
  const cont = !str && /\\\s*$/.test(text.replace(/#.*$/, ''));
  return { state: { depth, str: str && str.length === 3 ? str : null, cont }, lastCode, colon0, colon0End };
}

/**
 * Read a header starting at line k. Returns { start: k, end: row of the line with the final ':' , inline: bool }
 * or null when no ':' closes it within 200 lines.
 */
function readHeader(src, k) {
  let st = { depth: 0, str: null, cont: false };
  for (let i = k; i < Math.min(src.count, k + 200); i++) {
    const t = src.line(i);
    const r = scanLine(t, st);
    st = r.state;
    if (st.depth === 0 && !st.str && !st.cont && r.colon0) {
      return { start: k, end: i, inline: r.lastCode !== ':' };
    }
  }
  return null;
}

/** First line of the decorators above a header at line k (same indent), or k. */
function decoratorStart(src, k) {
  const ind = indentOf(src.line(k));
  let s = k;
  for (let i = k - 1; i >= 0 && i >= k - 50; i--) {
    const t = src.line(i);
    if (DECORATOR_RE.test(t) && indentOf(t) === ind) { s = i; continue; }
    // a multi-line decorator: a line inside brackets below an @ line
    if (!isBlank(t) && !isComment(t) && width(indentOf(t)) > width(ind)) {
      let j = i - 1; while (j >= 0 && j >= i - 20 && !DECORATOR_RE.test(src.line(j))) j--;
      if (j >= 0 && DECORATOR_RE.test(src.line(j)) && indentOf(src.line(j)) === ind) { s = j; i = j; continue; }
    }
    break;
  }
  return s;
}

/** End (exclusive) of the block whose header ends at headerEnd and starts at line k. */
function blockEnd(src, k, headerEnd, skip) {
  const w = width(indentOf(src.line(k)));
  let st = { depth: 0, str: null, cont: false };
  let lastCode = headerEnd;
  for (let i = headerEnd + 1; i < src.count; i++) {
    if (skip && skip.has(i)) { lastCode = i; continue; }
    const t = src.line(i);
    const clean = st.depth === 0 && !st.str && !st.cont;
    if (clean && !isBlank(t) && !isComment(t) && width(indentOf(t)) <= w) return lastCode + 1;
    st = scanLine(t, st).state;
    if (!isBlank(t)) lastCode = i;
  }
  return lastCode + 1;
}

/** The header directly above line L (L is the line right under the header), or null. */
function headerAbove(src, L) {
  for (let k = L - 1; k >= 0 && k >= L - 120; k--) {
    const t = src.line(k);
    if (HEADER_RE.test(t)) {
      const h = readHeader(src, k);
      if (h && h.end === L - 1 && !h.inline) return h;
      return null;
    }
    // a statement that ends at column 0 code cannot be inside a signature: stop early on obvious code
    if (k < L - 1 && /^\S/.test(t) && !/^[)\]}]/.test(t) && !isComment(t) && !DECORATOR_RE.test(t)) return null;
  }
  return null;
}

/** The innermost def/class whose header or block contains line L, or null. */
function enclosing(src, L, maxUp = 5000) {
  const lt = src.line(L) || '';
  for (let k = L; k >= 0 && k >= L - maxUp; k--) {
    const t = src.line(k);
    if (!HEADER_RE.test(t)) continue;
    const h = readHeader(src, k);
    if (!h) continue;
    if (L >= k && L <= h.end) return h;
    if (h.inline) continue;
    const end = blockEnd(src, k, h.end);
    if (L < end || (L === end && isBlank(lt))) {
      // a blank line right after the block still belongs to it only when its indent is deeper than the header
      if (L >= end && width(indentOf(lt)) <= width(indentOf(t))) continue;
      return h;
    }
  }
  return null;
}

/** Module docstring position: true when every line above L is blank, a comment, a shebang or an encoding line. */
function isModuleTop(src, L) {
  for (let i = 0; i < L; i++) {
    const t = src.line(i);
    if (!isBlank(t) && !isComment(t)) return false;
  }
  return true;
}

/** Detect the file's indent unit from up to 2,000 lines: '\t' or a run of spaces. */
function detectIndentUnit(src, fallback = '    ') {
  const counts = {}; let tabs = 0, prev = 0;
  for (let i = 0; i < Math.min(src.count, 2000); i++) {
    const t = src.line(i);
    if (isBlank(t) || isComment(t)) continue;
    const ind = indentOf(t);
    if (ind.startsWith('\t')) { tabs++; continue; }
    const d = ind.length - prev; prev = ind.length;
    if (d > 0 && d <= 8) counts[d] = (counts[d] || 0) + 1;
  }
  let best = 0, bestN = 0;
  for (const [d, n] of Object.entries(counts)) if (n > bestN) { best = +d; bestN = n; }
  if (tabs > bestN) return '\t';
  return best ? ' '.repeat(best) : fallback;
}

module.exports = { fromText, indentOf, width, isBlank, isComment, scanLine, readHeader, decoratorStart, blockEnd, headerAbove, enclosing, isModuleTop, detectIndentUnit, HEADER_RE };
