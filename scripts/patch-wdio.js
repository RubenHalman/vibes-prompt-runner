// scripts/patch-wdio.js
// Patch 1: wdio-vscode-service chromium wrapper
//   - Strip ChromeDriver/Chrome-only flags (incl. --disable-extensions) before they reach VS Code
//   - Fix array flag values (e.g. extensionDevelopmentPath) → expand to multiple --flag=val args
//   - Drop boolean-false and string-"false" flags; filter false/'false' from mixed arrays
// Patch 2: VS Code main.js
//   - Silence onUnknownOption handlers so any remaining unknown flags don't EPIPE-crash VS Code
const fs = require('fs');
const path = require('path');

// ── Patch 1: chromium/index.js ────────────────────────────────────────────────
// Use require.resolve so this works both in-repo and when installed as a package
// (consumer's node_modules takes priority over our own).
let chromiumTarget;
try {
  chromiumTarget = require.resolve('wdio-vscode-service/dist/chromium/index.js');
} catch (_) {
  chromiumTarget = path.join(__dirname, '..', 'node_modules', 'wdio-vscode-service', 'dist', 'chromium', 'index.js');
}
if (!fs.existsSync(chromiumTarget)) {
  console.log('patch-wdio: chromium/index.js not found, skipping patch 1');
} else {
  const PATCH_TAG = '// patch-wdio v7';
  const originalLine = `    const params = Object.entries(argv).map(([key, value]) => {`;
  const oldPatchMarker = '// patch-wdio v';
  const argsLine = '    const args = ';
  const newPatch = `    ${PATCH_TAG}
    // Flags that VS Code's arg parser doesn't recognise — passing them causes
    // onUnknownOption → console.warn → EPIPE → crash.
    const CHROMIUM_ONLY = new Set([
      // ChromeDriver-added flags
      'log-level','test-type','password-store','use-mock-keychain',
      'no-service-autorun','no-first-run','enable-automation',
      'remote-debugging-address','flag-switches-begin','flag-switches-end',
      'disable-field-trial-config','allow-pre-commit-input',
      'origin-trial-disabled-features','variations-seed-version',
      // wdio-vscode-service Chrome options (Chrome-specific, not VS Code CLI flags)
      'disable-background-networking','disable-client-side-phishing-detection',
      'disable-default-apps','disable-hang-monitor','disable-popup-blocking',
      'disable-prompt-on-repost','disable-sync','disable-updates',
      // ChromeDriver default that must NOT reach VS Code (conflicts with disableExtensions:false)
      'disable-extensions',
      // Chrome-specific feature flag overrides — VS Code doesn't use these
      // and they can interfere with Electron's built-in features (e.g. SW activation)
      'enable-features','disable-features',
    ]);
    console.info('[FAKE VSCode Binary] raw argv keys:', Object.keys(argv).join(', '));
    const params = Object.entries(argv)
      .filter(([key, value]) =>
        !/[A-Z]/.test(key) &&
        key !== 'vscode-binary-path' &&
        !CHROMIUM_ONLY.has(key) &&
        value !== false &&
        value !== 'false'
      )
      .flatMap(([key, value]) => {
        // Array values (e.g. extensionDevelopmentPath) → one --flag=val per element
        // Filter out false/'false' from mixed arrays before expanding
        if (Array.isArray(value)) {
          const items = value.filter(v => v !== false && v !== 'false');
          if (items.length === 0) return [];
          return items.map(v => (typeof v === 'boolean' && v) ? \`--\${key}\` : \`--\${key}=\${v}\`);
        }
        if (typeof value === 'boolean' && value) return [\`--\${key}\`];
        return [\`--\${key}=\${value}\`];
      });`;

  let src = fs.readFileSync(chromiumTarget, 'utf8');
  if (src.includes(PATCH_TAG)) {
    console.log('patch-wdio: chromium/index.js already at v6');
  } else if (src.includes(oldPatchMarker)) {
    // Upgrade from any earlier patch version (v1–v5).
    // Use argsLine as the end anchor so dangling code left by the broken v5
    // patcher (stray original-map body after the flatMap's });) is also removed.
    const blockStart = src.indexOf('    ' + oldPatchMarker);
    const blockEnd = src.indexOf(argsLine, blockStart);
    fs.writeFileSync(chromiumTarget, src.slice(0, blockStart) + newPatch + '\n' + src.slice(blockEnd));
    console.log('patch-wdio: chromium/index.js upgraded to v6');
  } else if (src.includes(originalLine)) {
    // Fresh install: replace the original .map() block up to (but not including) const args =
    const blockStart = src.indexOf(originalLine);
    const blockEnd = src.indexOf(argsLine, blockStart);
    fs.writeFileSync(chromiumTarget, src.slice(0, blockStart) + newPatch + '\n' + src.slice(blockEnd));
    console.log('patch-wdio: chromium/index.js patched (v6)');
  } else {
    console.warn('patch-wdio: chromium/index.js — expected line not found, skipping');
  }
}

// ── Patch 2: VS Code main.js — silence onUnknownOption console.warn ───────────
// When running as an installed package, the VS Code cache lives in the consumer's CWD.
// Fall back to process.cwd() at postinstall time (AVA_CONSUMER_CWD not set yet).
const CONSUMER_CWD = process.env.AVA_CONSUMER_CWD || process.cwd();
const vscodeCachePath = path.join(CONSUMER_CWD, '.wdio-vscode-service');
if (!fs.existsSync(vscodeCachePath)) {
  console.log('patch-wdio: .wdio-vscode-service not found, skipping patch 2');
} else {
  const glob = (dir, results = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) glob(full, results);
      else if (entry.name === 'main.js' && full.includes('app/out/')) results.push(full);
    }
    return results;
  };
  for (const mainJs of glob(vscodeCachePath)) {
    const VSCODE_PATCH_TAG = '/* patch-wdio-vscode */';
    let vsrc = fs.readFileSync(mainJs, 'utf8');
    if (vsrc.includes(VSCODE_PATCH_TAG)) {
      console.log(`patch-wdio: ${path.basename(path.dirname(path.dirname(path.dirname(mainJs))))} main.js already patched`);
      continue;
    }
    // Match onUnknownOption handlers regardless of variable names (minified code varies by VS Code version)
    // Try multiple patterns to handle arrow vs method syntax and warn vs error
    let patched = false;
    const NOOP = `onUnknownOption:_=>{${VSCODE_PATCH_TAG}}`;
    const patterns = [
      /onUnknownOption:\w+=>\{[^}]*console\.warn[^}]*\}/g,   // arrow + warn (older)
      /onUnknownOption:\w+=>\{[^}]*console\.error[^}]*\}/g,  // arrow + error (newer)
      /onUnknownOption:\w+=>\{[^{}]*\}/g,                    // arrow, any body (no nested braces)
    ];
    for (const re of patterns) {
      const replaced = vsrc.replace(re, NOOP);
      if (replaced.includes(VSCODE_PATCH_TAG)) { vsrc = replaced; patched = true; break; }
    }
    if (!patched) {
      // Fallback: replace any onUnknownOption property value (handles nested braces via balanced scan)
      const marker = 'onUnknownOption:';
      let idx = vsrc.indexOf(marker);
      while (idx !== -1 && !patched) {
        let depth = 0, i = idx + marker.length;
        // skip to opening brace (could be arrow func `x=>{` or method `(x){`)
        while (i < vsrc.length && vsrc[i] !== '{') i++;
        const bodyStart = i;
        i++; depth = 1;
        while (i < vsrc.length && depth > 0) {
          if (vsrc[i] === '{') depth++;
          else if (vsrc[i] === '}') depth--;
          i++;
        }
        vsrc = vsrc.slice(0, idx) + NOOP + vsrc.slice(i);
        patched = true;
      }
    }
    if (vsrc.includes(VSCODE_PATCH_TAG)) patched = true;
    if (patched) {
      fs.writeFileSync(mainJs, vsrc);
      console.log(`patch-wdio: VS Code main.js onUnknownOption handlers silenced`);
      // Re-sign the app bundle with an ad-hoc identity so macOS doesn't flag it as damaged.
      // Modifying any file inside a signed .app invalidates the bundle signature.
      // Not needed (or available) on Linux/Windows.
      if (process.platform === 'darwin' && mainJs.includes('.app/')) {
        const appBundle = mainJs.slice(0, mainJs.indexOf('.app/') + '.app'.length);
        try {
          require('child_process').execSync(`codesign --force --deep --sign - "${appBundle}"`, { stdio: 'pipe' });
          console.log(`patch-wdio: re-signed ${path.basename(appBundle)} with ad-hoc identity`);
        } catch (e) {
          console.warn(`patch-wdio: codesign failed (non-fatal): ${e.message?.slice(0, 120)}`);
        }
      }
    } else {
      console.warn(`patch-wdio: VS Code main.js handlers not found — may need updating for this VS Code version`);
    }
  }
}
