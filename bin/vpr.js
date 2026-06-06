#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

// Package root is always one directory above bin/
const PKG_ROOT     = path.resolve(__dirname, '..');
// Consumer's working directory — where their .env, sfdx-project, etc. live
const CONSUMER_CWD = process.cwd();
const pkg = require(path.join(PKG_ROOT, 'package.json'));

function loadDotEnv() {
  const envPath = path.join(CONSUMER_CWD, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Vibes Prompt Runner (vpr) ${pkg.version}

Usage:
  vpr
  vpr bootstrap

Runs the Vibes Prompt Runner WebdriverIO/VS Code harness from the current directory.
The current directory is the consumer project root for .env, sfdx-project/,
logs, and VS Code cache files.

Required for a real run:
  PROMPT                  Prompt sent to Agentforce Vibes
  SFDX_AUTH_URL           Dev Hub auth URL for scratch-org rotation, or
  TARGET_ORG_AUTH_URL     target org auth URL for target-org mode

Common optional variables:
  AUTO_APPROVE_COMMANDS=1
  AUTO_SELECT_OPTION=1
  AVA_PROFILE=live-analysis|live-metadata
  SFDX_PROJECT_PATH=./sfdx-project
  EXTENSIONS_PATH=./test/extensions
`);
  process.exit(0);
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

if (process.argv[2] === 'bootstrap') {
  loadDotEnv();
  process.env.AVA_PKG_ROOT     = PKG_ROOT;
  process.env.AVA_CONSUMER_CWD = CONSUMER_CWD;
  const bootstrap = spawnSync(
    process.execPath,
    [path.join(PKG_ROOT, 'scripts', 'bootstrap-extensions.js')],
    { stdio: 'inherit', env: process.env }
  );
  process.exit(bootstrap.status ?? 0);
}

loadDotEnv();

if (!process.env.PROMPT) {
  console.error('vpr: PROMPT is required. Set PROMPT in the environment or in .env. Run `vpr --help` for usage.');
  process.exit(2);
}

process.env.AVA_PKG_ROOT     = PKG_ROOT;
process.env.AVA_CONSUMER_CWD = CONSUMER_CWD;

// Step 1: prewdio (setup.js)
const setup = spawnSync(
  process.execPath,
  [path.join(PKG_ROOT, 'scripts', 'setup.js')],
  { stdio: 'inherit', env: process.env }
);
if (setup.status !== 0) process.exit(setup.status ?? 1);

// Step 2: wdio run
const wdioBin = (() => {
  try { return require.resolve('.bin/wdio', { paths: [CONSUMER_CWD, PKG_ROOT] }); } catch (_) {}
  try { return require.resolve('.bin/wdio', { paths: [PKG_ROOT] }); } catch (_) {}
  return 'wdio'; // fallback to PATH
})();
const wdio = spawnSync(
  wdioBin,
  ['run', path.join(PKG_ROOT, 'wdio.conf.mts')],
  { stdio: 'inherit', env: process.env, cwd: CONSUMER_CWD }
);

// Step 3: postwdio cleanup (best-effort)
try { execSync("pkill -9 -f 'wdio-vscode-service' 2>/dev/null || true", { shell: true }); } catch (_) {}

process.exit(wdio.status ?? 0);
