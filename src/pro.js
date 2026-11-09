'use strict';
// Zovo Pro switch. PRO_ENABLED = false ships every feature free: no "Pro" label, no prompt, no license code runs.
// When the owner turns it on, this feature asks for Zovo Pro (one-time, all Zovo tools) after FREE_TRIES uses:
//   the workspace docstring coverage report.
// Generating and updating docstrings, all styles, custom templates, JSDoc, file-wide commands and update on save stay free for good.
const PRO_ENABLED = false;
const SKU = 'docstring-pro';
const FREE_TRIES = 3;
const PRO_FEATURES = ['Docstring coverage report'];

function createPro({ vscode, context, enabled = PRO_ENABLED, license }) {
  vscode.commands.executeCommand('setContext', 'zovoDoc.proEnabled', !!enabled);
  let lic = null;
  if (enabled) {
    lic = license || require('./license').createLicense({ vscode, context, sku: SKU, name: 'Docstring Generator', commandPrefix: 'zovoDoc' });
  } else {
    // The license commands are listed in package.json but hidden while Pro is off. Called anyway, they say so.
    const free = () => vscode.window.showInformationMessage('Every Docstring Generator feature is free in this version. Nothing to unlock.');
    for (const c of ['unlockWithSponsors', 'enterLicenseKey', 'getPro', 'removeLicense']) context.subscriptions.push(vscode.commands.registerCommand('zovoDoc.' + c, free));
  }
  const KEY = 'zovoDoc.proTries';
  return {
    enabled: !!enabled,
    /** Labels for views: empty while Pro is off, so no "Pro" mark shows anywhere. */
    labels() { return enabled && lic && !lic.isPro(SKU) ? PRO_FEATURES : []; },
    /** True when the feature may run. Free while Pro is off; else licensed, or one of the first FREE_TRIES uses. */
    async allow(feature, detail) {
      if (!enabled) return true;
      await lic.ready;
      if (lic.isPro(SKU)) { if (lic.refresh) lic.refresh(); return true; }
      const tries = context.globalState.get(KEY, {});
      const used = tries[feature] || 0;
      if (used < FREE_TRIES) { tries[feature] = used + 1; await context.globalState.update(KEY, tries); return true; }
      return lic.requirePro(feature, detail);
    },
  };
}

module.exports = { createPro, PRO_ENABLED, SKU, FREE_TRIES, PRO_FEATURES };
