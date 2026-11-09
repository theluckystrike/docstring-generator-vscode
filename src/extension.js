'use strict';
// Docstring Generator for Python (Google, NumPy, Sphinx, Epytext) and JSDoc for JS/TS.
// No network, no telemetry. The parser (tree-sitter, wasm) loads from the package on first use.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scan = require('./core/scan');
const py = require('./core/python');
const R = require('./core/render');
const U = require('./core/update');
const J = require('./core/jsdoc');
const ts = require('./core/ts');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createPro } = require('./pro');

const EXT_ID = 'zovo.zovo-docstring-generator';
const SECTION = 'zovoDoc';
const PY = { language: 'python' };
const JS_LANGS = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'];
// Insert snippets with the whitespace as written: the docstring indent comes from the function body.
const KEEP = { undoStopBefore: true, undoStopAfter: true, keepWhitespace: true };
const TRIGGER_RE = /^([ \t]*)([rRuU]{0,2})("""|''')$/;

let rating = { success() {}, failure() {} };
let pro = null;
let log = null;

const MESSAGES = {
  lambda: 'A lambda cannot have a docstring. Turn it into a def to document it.',
  inline: 'This def has its body on the same line. Move the body to its own line, then generate the docstring.',
  nodef: 'No def or class here. Put the cursor on a def or class line, or inside its body.',
  nofunction: 'No function, method or class here. Put the cursor on its first line, or on the empty line above it.',
  syntax: 'Could not read this signature: the file has a syntax error near it.',
};

function now() { return performance.now(); }
function timing(op, ms, doc, extra) {
  const line = `${op} ${ms.toFixed(1)} ms, ${doc.lineCount} lines${extra ? ', ' + extra : ''}`;
  if (log) log.appendLine(`[${new Date().toISOString()}] ${line}  ${doc.uri.fsPath || doc.uri.toString()}`);
  const f = process.env.ZOVO_DOC_TIMING_LOG;
  if (f) { try { fs.appendFileSync(f, JSON.stringify({ op, ms: +ms.toFixed(2), lines: doc.lineCount, file: doc.uri.fsPath, extra: extra || '' }) + '\n'); } catch { /* ignore */ } }
}

function docSource(doc) { return { count: doc.lineCount, line: (i) => (i >= 0 && i < doc.lineCount ? doc.lineAt(i).text : '') }; }

function indentUnitFor(doc) {
  const ed = vscode.window.visibleTextEditors.find((e) => e.document === doc);
  if (ed && typeof ed.options.insertSpaces === 'boolean') return ed.options.insertSpaces ? ' '.repeat(Number(ed.options.tabSize) || 4) : '\t';
  return scan.detectIndentUnit(docSource(doc));
}

function expandPath(p, doc) {
  if (!p) return '';
  const folder = (doc && vscode.workspace.getWorkspaceFolder(doc.uri)) || (vscode.workspace.workspaceFolders || [])[0];
  let out = p.replace(/\$\{workspaceFolder\}/g, folder ? folder.uri.fsPath : '').replace(/\$\{userHome\}/g, os.homedir())
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] || '');
  if (out.startsWith('~/') || out === '~') out = path.join(os.homedir(), out.slice(1));
  if (!path.isAbsolute(out) && folder) out = path.join(folder.uri.fsPath, out);
  return out;
}

let warnedTemplate = '';
function options(doc) {
  const c = vscode.workspace.getConfiguration(SECTION, doc ? doc.uri : undefined);
  let style = c.get('style', 'google');
  let template = null;
  if (style === 'custom') {
    const p = expandPath(c.get('customTemplatePath', ''), doc);
    try { template = fs.readFileSync(p, 'utf8'); } catch {
      if (warnedTemplate !== p) { warnedTemplate = p; vscode.window.showWarningMessage(`Docstring template not found: ${p || '(zovoDoc.customTemplatePath is empty)'}. Using Google style.`); }
      style = 'google';
    }
  }
  const unit = doc ? indentUnitFor(doc) : '    ';
  return {
    style, template,
    includeTypes: c.get('includeTypes', 'always'),
    includeDefaults: c.get('includeDefaults', true),
    optionalMarker: c.get('optionalMarker', true),
    summaryOnNewLine: c.get('summaryOnNewLine', false),
    includeExtendedSummary: c.get('includeExtendedSummary', false),
    blankLineAfterLastSection: c.get('blankLineAfterLastSection', false),
    quote: c.get('quoteStyle', '"""'),
    classInitArgs: c.get('classInitArguments', 'class'),
    removedParameters: c.get('update.removedParameters', 'mark'),
    skipPrivate: c.get('bulk.skipPrivate', true),
    docIndent: unit === '\t' ? '\t' : '    ',
    indentUnit: unit,
  };
}

function report(error, quiet) {
  const msg = MESSAGES[error] || MESSAGES.nodef;
  if (quiet) vscode.window.setStatusBarMessage('Docstring: ' + msg, 6000);
  else vscode.window.showInformationMessage(msg);
}

function succeed(doc) { try { rating.success(doc.uri); } catch { /* never block the edit */ } }

// ---------------------------------------------------------------- Python: generate

async function snippetBelow(doc, line, o, quoteOverride, prefixOverride) {
  const t0 = now();
  const a = await py.analyze(docSource(doc), line, { mode: 'below', indentUnit: o.indentUnit, classInitArgs: o.classInitArgs });
  if (a.error) return { error: a.error };
  const opts = { ...o, quote: quoteOverride || o.quote };
  const r = R.renderDocstring(a.info, opts, a.bodyIndent);
  let text = r.text;
  if (prefixOverride) text = text.replace(opts.quote, prefixOverride + opts.quote);
  return { a, snippet: R.toSnippet(text), plain: R.toText(text), ms: now() - t0 };
}

class DocstringCompletion {
  async provideCompletionItems(doc, pos) {
    if (!vscode.workspace.getConfiguration(SECTION, doc.uri).get('generateOnTripleQuote', true)) return undefined;
    const line = doc.lineAt(pos.line).text;
    const before = line.slice(0, pos.character), after = line.slice(pos.character);
    const m = TRIGGER_RE.exec(before);
    if (!m || !/^[ \t]*("""|''')?[ \t]*$/.test(after)) return undefined;
    try {
      const o = options(doc);
      const s = await snippetBelow(doc, pos.line, o, m[3], m[2]);
      if (s.error) { if (s.error === 'lambda' || s.error === 'syntax' || s.error === 'inline') report(s.error, true); return undefined; }
      timing('completion', s.ms, doc, s.a.info.name || s.a.kind);
      const item = new vscode.CompletionItem('Generate Docstring', vscode.CompletionItemKind.Snippet);
      item.detail = `${label(o.style)} docstring${s.a.info.name ? ' for ' + s.a.info.name : ''}`;
      item.documentation = new vscode.MarkdownString().appendCodeblock(s.plain, 'python');
      item.insertText = new vscode.SnippetString(s.snippet);
      item.range = new vscode.Range(pos.line, 0, pos.line, line.length);
      item.filterText = m[2] + m[3];
      item.sortText = '\u0000';
      item.preselect = true;
      item.keepWhitespace = true; // indent exactly like the body, even in files that mix tabs and spaces
      item.command = { command: 'zovoDoc._inserted', title: '', arguments: [doc.uri] };
      return new vscode.CompletionList([item], false);
    } catch (e) {
      log.appendLine('completion failed: ' + (e && e.stack || e));
      return undefined;
    }
  }
}

function label(style) { return { google: 'Google', numpy: 'NumPy', sphinx: 'Sphinx', epytext: 'Epytext', custom: 'Custom' }[style] || 'Google'; }

/** `"""` + Enter when the suggestion was not accepted: expand the docstring anyway. */
async function onEnterFallback(e) {
  if (e.document.languageId !== 'python' || e.contentChanges.length !== 1) return;
  const ch = e.contentChanges[0];
  if (ch.rangeLength !== 0 || !/^\r?\n[ \t]*$/.test(ch.text)) return;
  const doc = e.document;
  const c = vscode.workspace.getConfiguration(SECTION, doc.uri);
  if (!c.get('generateOnEnter', true)) return;
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document !== doc) return;
  const L = ch.range.start.line;
  if (L + 1 >= doc.lineCount) return;
  const m = TRIGGER_RE.exec(doc.lineAt(L).text.replace(/[ \t]+$/, ''));
  if (!m) return;
  const next = doc.lineAt(L + 1).text;
  const closing = /^[ \t]*("""|''')[ \t]*$/.exec(next);
  if (!closing && !/^[ \t]*$/.test(next)) return;
  if (closing && closing[1] !== m[3]) return;
  // a closing quote further down means the user is writing a docstring by hand: leave it alone
  if (!closing) for (let i = L + 2; i < Math.min(doc.lineCount, L + 40); i++) { const t = doc.lineAt(i).text; if (t.includes(m[3])) return; if (/^\S/.test(t)) break; }
  const version = doc.version;
  const o = options(doc);
  const s = await snippetBelow(doc, L, o, m[3], m[2]);
  if (s.error) { if (s.error !== 'nodef') report(s.error, true); return; }
  if (doc.version !== version || vscode.window.activeTextEditor !== ed) return;
  const range = new vscode.Range(L, 0, L + 1, next.length);
  const ok = await ed.insertSnippet(new vscode.SnippetString(s.snippet), range, KEEP);
  timing('enter', s.ms, doc, s.a.info.name || s.a.kind);
  if (ok) succeed(doc);
}

async function generatePython(ed) {
  const doc = ed.document;
  const L = ed.selection.active.line;
  const o = options(doc);
  const lt = doc.lineAt(L).text;
  const t0 = now();
  // on the empty (or quotes-only) line right under a header: fill that line
  if (/^[ \t]*([rRuU]{0,2}("""|'''){1,2})?[ \t]*$/.test(lt) && (scan.headerAbove(docSource(doc), L) || scan.isModuleTop(docSource(doc), L))) {
    const s = await snippetBelow(doc, L, o);
    if (!s.error) {
      await ed.insertSnippet(new vscode.SnippetString(s.snippet), new vscode.Range(L, 0, L, lt.length), KEEP);
      timing('generate', now() - t0, doc, s.a.info.name || s.a.kind); succeed(doc); return;
    }
  }
  const a = await py.analyze(docSource(doc), L, { mode: 'enclosing', indentUnit: o.indentUnit, classInitArgs: o.classInitArgs });
  if (a.error) {
    if (a.error === 'nodef' && scan.isModuleTop(docSource(doc), L) && scan.isBlank(lt)) {
      const r = R.renderDocstring({ kind: 'module', params: [], attributes: [], raises: [] }, o, '');
      await ed.insertSnippet(new vscode.SnippetString(R.toSnippet(r.text) + '\n'), new vscode.Position(L, 0), KEEP);
      succeed(doc); return;
    }
    report(a.error); return;
  }
  if (a.doc) {
    const pick = await vscode.window.showInformationMessage(`${a.info.name || 'This definition'} already has a docstring.`, 'Update Docstring');
    if (pick) await updatePython(ed);
    return;
  }
  const r = R.renderDocstring(a.info, o, a.bodyIndent);
  await ed.insertSnippet(new vscode.SnippetString(R.toSnippet(r.text) + '\n'), new vscode.Position(a.insertLine, 0), KEEP);
  timing('generate', now() - t0, doc, a.info.name);
  succeed(doc);
}

// ---------------------------------------------------------------- Python: update

function lineIndent(doc, row) { return scan.indentOf(doc.lineAt(row).text); }

async function updatePython(ed) {
  const doc = ed.document;
  const o = options(doc);
  const t0 = now();
  const a = await py.analyze(docSource(doc), ed.selection.active.line, { mode: 'enclosing', indentUnit: o.indentUnit, classInitArgs: o.classInitArgs });
  if (a.error) { report(a.error); return; }
  if (!a.doc) { await generatePython(ed); return; }
  if (a.doc.concatenated) { vscode.window.showInformationMessage('This docstring is made of several string pieces. Join them into one string to update it.'); return; }
  const u = U.updateDocstring(a.doc, a.info, o, lineIndent(doc, a.doc.startRow));
  timing('update', now() - t0, doc, a.info.name);
  if (!u.changed) { vscode.window.setStatusBarMessage(`Docstring of ${a.info.name} is up to date.`, 5000); return; }
  await ed.edit((b) => b.replace(new vscode.Range(a.doc.startRow, a.doc.startCol, a.doc.endRow, a.doc.endCol), u.text));
  vscode.window.setStatusBarMessage(`Docstring of ${a.info.name} updated: ${u.notes.join('; ')}`, 8000);
  succeed(doc);
}

/** Edits for every def/class in a Python document. mode: 'update' (existing docstrings) or 'missing' (add). */
async function fileEdits(doc, mode) {
  const o = { ...options(doc), bulk: true };
  const text = doc.getText();
  const defs = await py.analyzeFile(text, { classInitArgs: o.classInitArgs });
  const edits = []; const notes = [];
  for (const d of defs) {
    if (mode === 'update') {
      if (!d.doc || d.doc.concatenated) continue;
      const u = U.updateDocstring(d.doc, d.info, o, lineIndent(doc, d.doc.startRow));
      if (u.changed) { edits.push(vscode.TextEdit.replace(new vscode.Range(d.doc.startRow, d.doc.startCol, d.doc.endRow, d.doc.endCol), u.text)); notes.push(`${d.info.name}: ${u.notes.join('; ')}`); }
    } else {
      if (d.doc || d.inline || d.firstRow == null || d.hasError) continue;
      if (o.skipPrivate && d.info.name.startsWith('_') && d.info.name !== '__init__') continue;
      const ind = lineIndent(doc, d.firstRow);
      const hdrInd = lineIndent(doc, d.headerStart);
      const bodyIndent = scan.width(ind) > scan.width(hdrInd) ? ind : hdrInd + o.indentUnit;
      const r = R.renderDocstring(d.info, o, bodyIndent);
      edits.push(vscode.TextEdit.insert(new vscode.Position(d.headerEnd + 1, 0), R.toText(r.text) + '\n'));
      notes.push(d.info.name);
    }
  }
  return { edits, notes, count: defs.length };
}

async function updateAllInFile(ed) {
  const doc = ed.document;
  if (doc.languageId !== 'python') { vscode.window.showInformationMessage('Update All Docstrings works on Python files.'); return; }
  const t0 = now();
  const { edits, notes, count } = await fileEdits(doc, 'update');
  timing('updateAll', now() - t0, doc, `${edits.length} of ${count}`);
  if (!edits.length) { vscode.window.showInformationMessage(`All docstrings in this file match their signatures (${count} definitions checked).`); return; }
  const we = new vscode.WorkspaceEdit(); we.set(doc.uri, edits);
  await vscode.workspace.applyEdit(we);
  log.appendLine(`Updated ${edits.length} docstrings in ${doc.uri.fsPath}:\n  ` + notes.join('\n  '));
  vscode.window.showInformationMessage(`Updated ${edits.length} docstring${edits.length === 1 ? '' : 's'}. Details are in the log.`, 'Show Log').then((p) => p && log.show());
  succeed(doc);
}

async function generateAllMissing(ed) {
  const doc = ed.document;
  if (doc.languageId !== 'python') { vscode.window.showInformationMessage('Add Missing Docstrings works on Python files.'); return; }
  const t0 = now();
  const { edits, notes, count } = await fileEdits(doc, 'missing');
  timing('generateAll', now() - t0, doc, `${edits.length} of ${count}`);
  if (!edits.length) { vscode.window.showInformationMessage(`Every function and class here has a docstring (${count} checked).`); return; }
  const we = new vscode.WorkspaceEdit(); we.set(doc.uri, edits);
  await vscode.workspace.applyEdit(we);
  vscode.window.showInformationMessage(`Added ${edits.length} docstring${edits.length === 1 ? '' : 's'} (${notes.slice(0, 6).join(', ')}${notes.length > 6 ? ', ...' : ''}).`);
  succeed(doc);
}

// ---------------------------------------------------------------- JSDoc

function jsOptions(doc) {
  const o = options(doc);
  const c = vscode.workspace.getConfiguration(SECTION, doc.uri);
  if (doc.languageId.startsWith('typescript') && !c.get('jsdoc.typesInTypeScript', true)) o.includeTypes = 'never';
  return o;
}

async function generateJsdoc(ed, { line } = {}) {
  const doc = ed.document;
  const L = line != null ? line : ed.selection.active.line;
  const o = jsOptions(doc);
  const t0 = now();
  const a = await J.analyze(doc.getText(), doc.languageId, L);
  if (a.error) { report(a.error); return false; }
  if (a.existing) return updateJsdoc(ed, a, o, t0);
  const text = J.render(a.info, o, a.indent);
  // on an empty or "/**" line right above: fill that line; else insert above the function
  const lt = doc.lineAt(L).text;
  const fill = L < a.anchorRow && /^\s*(\/\*\*\s*(\*\/)?)?\s*$/.test(lt);
  if (fill) await ed.insertSnippet(new vscode.SnippetString(R.toSnippet(text)), new vscode.Range(L, 0, L, lt.length), KEEP);
  else await ed.insertSnippet(new vscode.SnippetString(R.toSnippet(text) + '\n'), new vscode.Position(a.anchorRow, 0), KEEP);
  timing('jsdoc', now() - t0, doc, a.info.name);
  succeed(doc);
  return true;
}

async function updateJsdoc(ed, a, o, t0) {
  const doc = ed.document;
  const u = J.updateBlock(a.existing.text, a.info, o, a.indent);
  timing('jsdocUpdate', now() - t0, doc, a.info.name);
  if (!u.changed) { vscode.window.setStatusBarMessage(`JSDoc of ${a.info.name || 'this function'} is up to date.`, 5000); return true; }
  await ed.edit((b) => b.replace(new vscode.Range(a.existing.startRow, a.existing.startCol, a.existing.endRow, a.existing.endCol), u.text));
  vscode.window.setStatusBarMessage(`JSDoc updated: ${u.notes.join('; ')}`, 8000);
  succeed(doc);
  return true;
}

class JsdocCompletion {
  async provideCompletionItems(doc, pos) {
    const line = doc.lineAt(pos.line).text;
    const before = line.slice(0, pos.character), after = line.slice(pos.character);
    if (!/^\s*\/\*\*$/.test(before) || !/^\s*(\*\/)?\s*$/.test(after)) return undefined;
    try {
      const o = jsOptions(doc);
      const a = await J.analyze(doc.getText(), doc.languageId, pos.line);
      if (a.error || a.existing || a.anchorRow <= pos.line) return undefined;
      const text = J.render(a.info, o, a.indent);
      const item = new vscode.CompletionItem('JSDoc with types', vscode.CompletionItemKind.Snippet);
      item.detail = 'Zovo: @param types, defaults, @returns, @throws';
      item.documentation = new vscode.MarkdownString().appendCodeblock(R.toText(text), 'javascript');
      item.insertText = new vscode.SnippetString(R.toSnippet(text));
      item.range = new vscode.Range(pos.line, 0, pos.line, line.length);
      item.filterText = '/**';
      item.keepWhitespace = true;
      item.sortText = '\u0000';
      item.command = { command: 'zovoDoc._inserted', title: '', arguments: [doc.uri] };
      return new vscode.CompletionList([item], false);
    } catch (e) { log.appendLine('jsdoc completion failed: ' + (e && e.stack || e)); return undefined; }
  }
}

// ---------------------------------------------------------------- code actions

class Actions {
  async provideCodeActions(doc, range) {
    const L = range.start.line;
    const t = doc.lineAt(L).text;
    try {
      if (doc.languageId === 'python') {
        if (!scan.HEADER_RE.test(t) && !/^\s*@/.test(t)) return [];
        const o = options(doc);
        const src = docSource(doc);
        let row = L;
        if (/^\s*@/.test(t)) { while (row < doc.lineCount - 1 && /^\s*@/.test(doc.lineAt(row).text)) row++; }
        const a = await py.analyze(src, row, { mode: 'enclosing', indentUnit: o.indentUnit, classInitArgs: o.classInitArgs });
        if (a.error) return [];
        if (!a.doc) return [action('Generate docstring', 'zovoDoc.generate', doc, row)];
        if (a.doc.concatenated) return [];
        const u = U.updateDocstring(a.doc, a.info, o, lineIndent(doc, a.doc.startRow));
        return u.changed ? [action(`Update docstring (${u.notes.slice(0, 3).join('; ')})`, 'zovoDoc.update', doc, row)] : [];
      }
      if (!/\bfunction\b|=>|^\s*(public|private|protected|static|async|get|set|export|abstract)?\s*[\w$]+\s*(<[^>]*>)?\s*\(|\bclass\b/.test(t)) return [];
      const a = await J.analyze(doc.getText(), doc.languageId, L);
      if (a.error || a.anchorRow !== L && !(L > a.anchorRow)) return [];
      if (!a.existing) return [action('Generate JSDoc', 'zovoDoc.generateJsdoc', doc, L)];
      const u = J.updateBlock(a.existing.text, a.info, jsOptions(doc), a.indent);
      return u.changed ? [action(`Update JSDoc (${u.notes.slice(0, 3).join('; ')})`, 'zovoDoc.generateJsdoc', doc, L)] : [];
    } catch { return []; }
  }
}
function action(title, command, doc, line) {
  const a = new vscode.CodeAction(title, vscode.CodeActionKind.RefactorRewrite);
  a.command = { command, title, arguments: [doc.uri, line] };
  return a;
}

// ---------------------------------------------------------------- update on save

async function onWillSave(e) {
  const doc = e.document;
  if (doc.languageId !== 'python') return;
  if (!vscode.workspace.getConfiguration(SECTION, doc.uri).get('updateOnSave', false)) return;
  e.waitUntil((async () => {
    try { const r = await fileEdits(doc, 'update'); if (r.edits.length) log.appendLine(`On save, updated ${r.edits.length} docstrings in ${doc.uri.fsPath}`); return r.edits; } catch (err) { log.appendLine('update on save failed: ' + err); return []; }
  })());
}

// ---------------------------------------------------------------- coverage report (Zovo Pro when switched on)

async function coverageReport() {
  if (!(await pro.allow('Docstring coverage report', 'A report of the functions and classes without a docstring, or with a stale one, across the workspace.'))) return;
  if (!vscode.workspace.workspaceFolders) { vscode.window.showInformationMessage('Open a folder first.'); return; }
  const o = options(null);
  const maxBytes = vscode.workspace.getConfiguration(SECTION).get('report.maxFileMB', 2) * 1024 * 1024;
  const rows = [];
  let total = 0, documented = 0, stale = 0, skipped = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Docstring coverage', cancellable: true }, async (progress, token) => {
    const files = await vscode.workspace.findFiles('**/*.py', '{**/node_modules/**,**/.venv/**,**/venv/**,**/site-packages/**,**/.git/**,**/__pycache__/**,**/.tox/**}', 20000, token);
    let i = 0;
    for (const f of files) {
      if (token.isCancellationRequested) break;
      i++; if (i % 20 === 0) progress.report({ message: `${i} of ${files.length} files`, increment: 2000 / files.length });
      let text;
      try { const st = await fs.promises.stat(f.fsPath); if (st.size > maxBytes) { skipped++; continue; } text = await fs.promises.readFile(f.fsPath, 'utf8'); } catch { skipped++; continue; }
      let defs;
      try { defs = await py.analyzeFile(text, { classInitArgs: o.classInitArgs }); } catch { skipped++; continue; }
      const lines = text.split(/\r?\n/);
      let fMissing = [], fStale = [], fTotal = 0;
      for (const d of defs) {
        if (o.skipPrivate && d.info.name.startsWith('_') && d.info.name !== '__init__') continue;
        fTotal++;
        if (!d.doc) { fMissing.push(d); continue; }
        if (d.doc.concatenated) continue;
        const ind = scan.indentOf(lines[d.doc.startRow] || '');
        if (U.updateDocstring(d.doc, d.info, { ...o, bulk: true }, ind).changed) fStale.push(d);
      }
      total += fTotal; documented += fTotal - fMissing.length; stale += fStale.length;
      if (fMissing.length || fStale.length) rows.push({ f, fTotal, fMissing, fStale });
    }
  });
  const rel = (u) => vscode.workspace.asRelativePath(u);
  const pct = total ? Math.round((documented / total) * 100) : 100;
  const md = [`# Docstring coverage`, '', `${documented} of ${total} public functions and classes have a docstring (${pct} %). ${stale} docstrings do not match their signature.${skipped ? ` ${skipped} files were skipped (too large or unreadable).` : ''}`, ''];
  if (rows.length) {
    md.push('| File | Without docstring | Stale |', '|---|---|---|');
    rows.sort((a, b) => b.fMissing.length + b.fStale.length - a.fMissing.length - a.fStale.length);
    for (const r of rows.slice(0, 500)) {
      const link = (d) => `[${d.info.name}](${r.f.with({ fragment: `L${d.headerStart + 1}` }).toString()})`;
      md.push(`| ${rel(r.f)} | ${r.fMissing.slice(0, 12).map(link).join(', ')}${r.fMissing.length > 12 ? ` and ${r.fMissing.length - 12} more` : ''} | ${r.fStale.slice(0, 12).map(link).join(', ')} |`);
    }
  }
  md.push('', 'Fix a file: open it and run Docstring: Add Missing Docstrings in File, or Docstring: Update All Docstrings in File.');
  if (support.showLinks(vscode, SECTION)) md.push('', '---', support.footerMarkdown(SECTION));
  const d = await vscode.workspace.openTextDocument({ language: 'markdown', content: md.join('\n') + '\n' });
  await vscode.window.showTextDocument(d, { preview: false });
}

// ---------------------------------------------------------------- activation

function withEditor(fn, langs) {
  return async (uri, line) => {
    let ed = vscode.window.activeTextEditor;
    if (uri && uri instanceof vscode.Uri && (!ed || ed.document.uri.toString() !== uri.toString())) ed = await vscode.window.showTextDocument(uri);
    if (!ed) { vscode.window.showInformationMessage('Open a Python, JavaScript or TypeScript file first.'); return; }
    if (typeof line === 'number') { const p = new vscode.Position(line, ed.document.lineAt(line).text.length); ed.selection = new vscode.Selection(p, p); }
    if (langs && !langs.includes(ed.document.languageId)) { vscode.window.showInformationMessage(`This command works in ${langs.includes('python') ? 'Python' : 'JavaScript and TypeScript'} files.`); return; }
    try { await fn(ed); } catch (e) {
      log.appendLine('command failed: ' + (e && e.stack || e));
      rating.failure();
      vscode.window.showErrorMessage('Docstring Generator hit an error. Details are in the log (Docstring: Show Log).');
    }
  };
}

function activate(context) {
  log = vscode.window.createOutputChannel('Docstring Generator');
  context.subscriptions.push(log);
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: SECTION, name: 'Docstring Generator' });
  support.registerSupport({ vscode, context, prefix: SECTION, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  ts.init().catch((e) => log.appendLine('parser init failed: ' + e)); // warm up (about 20 ms) so the first """ is instant

  const pyOnly = ['python'];
  const generate = async (ed) => (ed.document.languageId === 'python' ? generatePython(ed) : JS_LANGS.includes(ed.document.languageId) ? generateJsdoc(ed) : vscode.window.showInformationMessage('Generate Docstring works in Python, JavaScript and TypeScript files.'));
  const update = async (ed) => (ed.document.languageId === 'python' ? updatePython(ed) : JS_LANGS.includes(ed.document.languageId) ? generateJsdoc(ed) : vscode.window.showInformationMessage('Update Docstring works in Python, JavaScript and TypeScript files.'));
  context.subscriptions.push(
    vscode.commands.registerCommand('zovoDoc.generate', withEditor(generate)),
    vscode.commands.registerCommand('zovoDoc.update', withEditor(update)),
    vscode.commands.registerCommand('zovoDoc.updateAllInFile', withEditor(updateAllInFile, pyOnly)),
    vscode.commands.registerCommand('zovoDoc.generateAllMissingInFile', withEditor(generateAllMissing, pyOnly)),
    vscode.commands.registerCommand('zovoDoc.generateJsdoc', withEditor((ed) => generateJsdoc(ed), JS_LANGS)),
    vscode.commands.registerCommand('zovoDoc.coverageReport', async () => { try { await coverageReport(); } catch (e) { log.appendLine('report failed: ' + (e && e.stack || e)); vscode.window.showErrorMessage('The coverage report failed. Details are in the log.'); } }),
    vscode.commands.registerCommand('zovoDoc.chooseStyle', async () => {
      const cur = vscode.workspace.getConfiguration(SECTION).get('style', 'google');
      const items = [['google', 'Google', 'Args:, Returns:, Raises:'], ['numpy', 'NumPy', 'Parameters / ---------- sections'], ['sphinx', 'Sphinx (reST)', ':param x:, :type x:, :rtype:'], ['epytext', 'Epytext', '@param x:, @type x:, @rtype:'], ['custom', 'Custom template', 'your own Mustache template file']]
        .map(([id, lbl, d]) => ({ label: lbl, description: d + (id === cur ? '  (current)' : ''), id }));
      const p = await vscode.window.showQuickPick(items, { placeHolder: 'Docstring style' });
      if (!p) return;
      const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration(SECTION).update('style', p.id, target);
      if (p.id === 'custom') vscode.commands.executeCommand('workbench.action.openSettings', 'zovoDoc.customTemplatePath');
    }),
    vscode.commands.registerCommand('zovoDoc.showLog', () => log.show()),
    vscode.commands.registerCommand('zovoDoc._inserted', (uri) => { const d = vscode.workspace.textDocuments.find((x) => x.uri.toString() === String(uri)); if (d) succeed(d); }),
    vscode.languages.registerCompletionItemProvider(PY, new DocstringCompletion(), '"', "'"),
    vscode.languages.registerCompletionItemProvider(JS_LANGS.map((language) => ({ language })), new JsdocCompletion(), '*'),
    vscode.languages.registerCodeActionsProvider([PY, ...JS_LANGS.map((language) => ({ language }))], new Actions(), { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] }),
    vscode.workspace.onDidChangeTextDocument((e) => { onEnterFallback(e).catch((err) => log.appendLine('enter fallback failed: ' + err)); }),
    vscode.workspace.onWillSaveTextDocument(onWillSave),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, expandPath };
