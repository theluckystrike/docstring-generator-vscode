'use strict';
// Runs activate() against a small fake `vscode` and drives the """ completion, the Enter fallback and the commands.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const os = require('os');

function fakeVscode() {
  const st = { commands: new Map(), completion: [], actions: [], change: [], willSave: [], messages: [], status: [], inserted: [], edits: [], config: {} };
  class Position { constructor(l, c) { this.line = l; this.character = c; } }
  class Range { constructor(a, b, c, d) { if (typeof a === 'object') { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); } } }
  class Selection extends Range { constructor(a, b) { super(a, b); this.active = b; } }
  class SnippetString { constructor(v) { this.value = v; } }
  class CompletionItem { constructor(l, k) { this.label = l; this.kind = k; } }
  class CompletionList { constructor(items, inc) { this.items = items; this.isIncomplete = inc; } }
  class MarkdownString { constructor() { this.value = ''; } appendCodeblock(c) { this.value += c; return this; } }
  class CodeAction { constructor(t, k) { this.title = t; this.kind = k; } }
  class WorkspaceEdit { constructor() { this.map = new Map(); } set(u, e) { this.map.set(String(u), e); } }
  const TextEdit = { replace: (r, t) => ({ range: r, newText: t }), insert: (p, t) => ({ range: new Range(p, p), newText: t }) };
  const Uri = { file: (p) => ({ fsPath: p, toString: () => 'file://' + p, scheme: 'file', path: p }), parse: (s) => ({ toString: () => s }) };
  const vscode = {
    Position, Range, Selection, SnippetString, CompletionItem, CompletionList, MarkdownString, CodeAction, WorkspaceEdit, TextEdit, Uri,
    CompletionItemKind: { Snippet: 27 }, CodeActionKind: { RefactorRewrite: 'refactor.rewrite' }, ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2 }, QuickPickItemKind: { Separator: -1 },
    env: { uriScheme: 'vscode', appName: 'Visual Studio Code', openExternal: async () => true },
    extensions: { getExtension: () => undefined },
    commands: { registerCommand: (id, fn) => { st.commands.set(id, fn); return { dispose() {} }; }, executeCommand: async () => undefined },
    languages: {
      registerCompletionItemProvider: (sel, p, ...trig) => { st.completion.push({ sel, p, trig }); return { dispose() {} }; },
      registerCodeActionsProvider: (sel, p) => { st.actions.push({ sel, p }); return { dispose() {} }; },
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showInformationMessage: async (m) => { st.messages.push(m); return undefined; },
      showWarningMessage: async (m) => { st.messages.push(m); return undefined; },
      showErrorMessage: async (m) => { st.messages.push('ERR ' + m); return undefined; },
      setStatusBarMessage: (m) => { st.status.push(m); return { dispose() {} }; },
      visibleTextEditors: [], activeTextEditor: undefined, state: { focused: true },
      onDidChangeWindowState: () => ({ dispose() {} }),
    },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k in st.config ? st.config[k] : d), update: async () => {} }),
      onDidChangeTextDocument: (fn) => { st.change.push(fn); return { dispose() {} }; },
      onWillSaveTextDocument: (fn) => { st.willSave.push(fn); return { dispose() {} }; },
      getWorkspaceFolder: () => undefined, workspaceFolders: undefined, textDocuments: [],
      applyEdit: async (we) => { st.edits.push(we); return true; },
    },
  };
  return { vscode, st };
}

function fakeDoc(text, languageId = 'python') {
  const doc = {
    uri: { fsPath: path.join(os.tmpdir(), 'x.py'), toString: () => 'file:///x.py', scheme: 'file' }, languageId, version: 1,
    get lineCount() { return this._lines.length; }, _lines: text.split('\n'),
    lineAt(i) { return { text: this._lines[i] }; }, getText() { return this._lines.join('\n'); },
  };
  return doc;
}
function fakeEditor(doc, line, col, st) {
  return {
    document: doc, options: { insertSpaces: true, tabSize: 4 },
    selection: { active: { line, character: col } },
    insertSnippet: async (s, where) => { st.inserted.push({ snippet: s.value, where }); return true; },
    edit: async (fn) => { const b = { replace: (r, t) => st.inserted.push({ text: t, where: r }) }; fn(b); return true; },
  };
}

let fx;
test.before(() => {
  fx = fakeVscode();
  const orig = Module._load;
  Module._load = function (req, ...rest) { if (req === 'vscode') return fx.vscode; return orig.call(this, req, ...rest); };
  const ext = require('../src/extension');
  const ctx = { subscriptions: [], globalState: { get: (k, d) => d, update: async () => {}, keys: () => [] }, extensionUri: { fsPath: '/ext', toString: () => 'file:///ext' }, globalStorageUri: { fsPath: '/gs', toString: () => 'file:///gs' } };
  ext.activate(ctx);
});

test('activate registers the commands, completion providers and code actions', () => {
  for (const c of ['zovoDoc.generate', 'zovoDoc.update', 'zovoDoc.updateAllInFile', 'zovoDoc.generateAllMissingInFile', 'zovoDoc.generateJsdoc', 'zovoDoc.coverageReport', 'zovoDoc.chooseStyle', 'zovoDoc.supportDeveloper', 'zovoDoc.moreViewers', 'zovoDoc.getPro'])
    assert.ok(fx.st.commands.has(c), c);
  assert.equal(fx.st.completion.length, 2);
  assert.deepEqual(fx.st.completion[0].trig, ['"', "'"]);
  assert.equal(fx.st.actions.length, 1);
});

test('typing """ under a def offers one preselected "Generate Docstring" item that replaces the whole line', async () => {
  const doc = fakeDoc('def f(a: int, b=2) -> str:\n    """"""\n    return "x"\n');
  const p = fx.st.completion[0].p;
  const list = await p.provideCompletionItems(doc, new fx.vscode.Position(1, 7));
  assert.equal(list.items.length, 1);
  const it = list.items[0];
  assert.equal(it.label, 'Generate Docstring');
  assert.equal(it.filterText, '"""');
  assert.equal(it.range.start.character, 0);
  assert.equal(it.range.end.character, 10);
  assert.match(it.insertText.value, /^ {4}"""\$\{1:Summary\.\}\n\n {4}Args:\n {8}a \(int\): \$\{2:Description of a\.\}/);
  // nothing when the quotes are not alone on the line, or not under a def
  assert.equal(await p.provideCompletionItems(fakeDoc('x = """'), new fx.vscode.Position(0, 7)), undefined);
  assert.equal(await p.provideCompletionItems(fakeDoc('x = 1\n"""'), new fx.vscode.Position(1, 3)), undefined);
});

test('Enter after """ (suggestion not picked) expands the docstring in place', async () => {
  const doc = fakeDoc('def f(a):\n    """\n    """\n    return a');
  const ed = fakeEditor(doc, 2, 4, fx.st);
  fx.vscode.window.activeTextEditor = ed;
  fx.st.inserted.length = 0;
  await fx.st.change[0]({ document: doc, contentChanges: [{ rangeLength: 0, text: '\n    ', range: new fx.vscode.Range(1, 7, 1, 7) }] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fx.st.inserted.length, 1);
  assert.match(fx.st.inserted[0].snippet, /Args:\n {8}a \(\$\{2:type\}\)/);
  assert.equal(fx.st.inserted[0].where.start.line, 1);
  assert.equal(fx.st.inserted[0].where.end.line, 2);
});

test('Generate Docstring command on a lambda line says why nothing was inserted', async () => {
  const doc = fakeDoc('square = lambda x: x * x\n');
  fx.vscode.window.activeTextEditor = fakeEditor(doc, 0, 3, fx.st);
  fx.st.messages.length = 0;
  await fx.st.commands.get('zovoDoc.generate')();
  assert.match(fx.st.messages[0], /lambda cannot have a docstring/);
});

test('Update Docstring command rewrites the docstring and keeps the text', async () => {
  const doc = fakeDoc('def f(alpha, b):\n    """Do it.\n\n    Args:\n        a: Hand text.\n    """\n    return 1\n');
  fx.vscode.window.activeTextEditor = fakeEditor(doc, 0, 3, fx.st);
  fx.st.inserted.length = 0;
  await fx.st.commands.get('zovoDoc.update')();
  assert.equal(fx.st.inserted.length, 1);
  assert.match(fx.st.inserted[0].text, /alpha: Hand text\.\n {8}b: Description of b\./);
  assert.match(fx.st.status.pop(), /renamed a to alpha; added b/);
});

test('code action on a def line: Generate, then Update with a summary of the change', async () => {
  const p = fx.st.actions[0].p;
  const a1 = await p.provideCodeActions(fakeDoc('def f(a):\n    return a\n'), new fx.vscode.Range(0, 0, 0, 0));
  assert.equal(a1[0].title, 'Generate docstring');
  const a2 = await p.provideCodeActions(fakeDoc('def f(a, b):\n    """X.\n\n    Args:\n        a: A.\n    """\n'), new fx.vscode.Range(0, 0, 0, 0));
  assert.equal(a2[0].title, 'Update docstring (added b)');
});

test('Update All Docstrings in File and Add Missing Docstrings apply one workspace edit', async () => {
  const doc = fakeDoc('def f(a, b):\n    """X.\n\n    Args:\n        a: A.\n    """\n\ndef g(x):\n    print(x)\n\ndef _p():\n    pass\n');
  fx.vscode.window.activeTextEditor = fakeEditor(doc, 0, 0, fx.st);
  fx.st.edits.length = 0;
  await fx.st.commands.get('zovoDoc.updateAllInFile')();
  await fx.st.commands.get('zovoDoc.generateAllMissingInFile')();
  assert.equal(fx.st.edits.length, 2);
  const missing = [...fx.st.edits[1].map.values()][0];
  assert.equal(missing.length, 1, 'g only: _p is private');
  assert.match(missing[0].newText, /^ {4}"""Summary\.\n\n {4}Args:\n {8}x \(type\): Description of x\.\n {4}"""\n$/);
});
