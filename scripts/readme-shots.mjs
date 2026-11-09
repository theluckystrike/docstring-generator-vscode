// README screenshots in real VS Code with the staged vsix: the """ suggestion and its result, Update Docstring, JSDoc.
// Usage: node readme-shots.mjs <vsix> <outdir> [port]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launch, installVsix, sleep, portAnswers } from './vsc.mjs';
const [VSIX, OUT, PORT = '9283'] = process.argv.slice(2);
const SRC = path.join(os.homedir(), 'docstring-generator-work', 'shots-src');
const W = path.join(os.homedir(), 'docstring-generator-work', 'gate', 'readme-shots');
if (await portAnswers(+PORT)) { console.error('port busy'); process.exit(2); }
fs.rmSync(W, { recursive: true, force: true }); fs.mkdirSync(path.join(W, 'ws'), { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(W, 'ws', f));
console.log(installVsix(W, VSIX).code);
const vs = await launch(W, +PORT, path.join(W, 'ws'), { 'editor.minimap.enabled': false, 'editor.fontSize': 15, 'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'editor.acceptSuggestionOnEnter': 'on', 'files.autoSave': 'off', 'workbench.activityBar.location': 'hidden', 'breadcrumbs.enabled': false, 'editor.suggest.showStatusBar': false });
const open = async (f) => { vs.open(path.join(W, 'ws', f)); await vs.waitFor(async () => (await vs.activeTitle()).includes(f), 15000); await sleep(1500); await vs.focusEditor(); };
try {
  await sleep(4000);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  await vs.command('View: Close Secondary Side Bar').catch(() => {});
  await open('shop.py');
  await vs.gotoLine(7); await vs.end(); await vs.typeKeys('"""'); await sleep(1500);
  await vs.key(' ', 'Space', 2, 32); await sleep(1200); // Ctrl+Space toggles the details pane with the preview
  await vs.shot(path.join(OUT, 'suggest-dark.png'));
  await vs.enter(); await sleep(1200);
  await vs.key('Escape', 'Escape', 0, 27); await sleep(200);
  await vs.gotoLine(1); await sleep(400);
  await vs.shot(path.join(OUT, 'generate-dark.png'));
  await vs.save();
  await open('update_demo.py');
  await vs.shot(path.join(OUT, 'update-before.png'));
  await vs.gotoLine(1); await vs.command('Docstring: Update Docstring (Signature Changed)'); await sleep(1500);
  await vs.shot(path.join(OUT, 'update-dark.png'));
  await vs.save();
  console.log(fs.readFileSync(path.join(W, 'ws', 'shop.py'), 'utf8'));
  console.log(fs.readFileSync(path.join(W, 'ws', 'update_demo.py'), 'utf8'));
} finally { await vs.close(); fs.rmSync(W, { recursive: true, force: true }); }
