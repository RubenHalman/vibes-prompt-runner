// scripts/setup.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

// Load .env before reading any env vars
;(function loadDotEnv() {
  const CONSUMER_CWD = process.env.AVA_CONSUMER_CWD || process.cwd();
  const envPath = path.resolve(CONSUMER_CWD, '.env');
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
})();

// --- SFDX project workspace ---
// Point SFDX_PROJECT_PATH to any repo's sfdx-project dir, or let it scaffold a minimal one.
// PKG_ROOT: where this package lives (inside node_modules/ when installed as a package)
// projectRoot: consumer's working directory — where sfdx-project, auth files, logs live
const PKG_ROOT    = process.env.AVA_PKG_ROOT     || path.resolve(__dirname, '..');
const projectRoot = process.env.AVA_CONSUMER_CWD || process.cwd();
const sfdxProjectDir = process.env.SFDX_PROJECT_PATH
  ? path.resolve(process.env.SFDX_PROJECT_PATH)
  : path.join(projectRoot, 'sfdx-project');

if (!fs.existsSync(sfdxProjectDir)) {
  console.log(`No sfdx-project found at ${sfdxProjectDir} — scaffolding a minimal one`);
  fs.mkdirSync(path.join(sfdxProjectDir, 'force-app', 'main', 'default'), { recursive: true });
  fs.writeFileSync(
    path.join(sfdxProjectDir, 'sfdx-project.json'),
    JSON.stringify({
      packageDirectories: [{ path: 'force-app', default: true }],
      name: 'sfdx-project',
      namespace: '',
      sfdcLoginUrl: 'https://login.salesforce.com',
      sourceApiVersion: '62.0',
    }, null, 2)
  );
  console.log(`Scaffolded sfdx-project at ${sfdxProjectDir}`);
} else {
  console.log(`Using sfdx-project at ${sfdxProjectDir}`);
}

// --- Einstein extension install ---
// Install salesforcedx-einstein-gpt into the wdio extensions dir so VS Code discovers it
// as a regular extension. Loading it via --extension-development-path does NOT trigger
// workspace-based activationEvents when VS Code runs with --extension-tests-path.
const EXTENSIONS_BASE = process.env.EXTENSIONS_PATH
  ? path.resolve(process.env.EXTENSIONS_PATH)
  : path.join(PKG_ROOT, 'test', 'extensions');

try {
  execFileSync(process.execPath, [path.join(PKG_ROOT, 'scripts', 'bootstrap-extensions.js')], {
    stdio: 'inherit',
    env: process.env,
  });
} catch (err) {
  console.error('[extensions] Failed to bootstrap Salesforce VS Code extensions');
  process.exit(err.status || 1);
}

const einsteinSrc = path.join(EXTENSIONS_BASE, 'salesforcedx-einstein-gpt');
const extensionsDir = path.join(os.homedir(), '.wdio-vscode-service', 'storage', 'extensions');
const extensionsJson = path.join(extensionsDir, 'extensions.json');

if (!fs.existsSync(einsteinSrc)) {
  console.warn('Einstein extension not found at', einsteinSrc, '— skipping install');
} else {
  const einsteinPkg = JSON.parse(fs.readFileSync(path.join(einsteinSrc, 'package.json')));
  const einsteinVersion = einsteinPkg.version;
  const einsteinId = `${einsteinPkg.publisher}.${einsteinPkg.name}`;
  const einsteinDest = path.join(extensionsDir, `${einsteinId}-${einsteinVersion}`);

  if (!fs.existsSync(einsteinDest)) {
    fs.mkdirSync(extensionsDir, { recursive: true });
    fs.cpSync(einsteinSrc, einsteinDest, { recursive: true });
    console.log(`Installed einstein extension v${einsteinVersion} to ${einsteinDest}`);
  } else {
    console.log(`Einstein extension v${einsteinVersion} already installed`);
  }

  // Register in extensions.json
  let exts = [];
  if (fs.existsSync(extensionsJson)) {
    try { exts = JSON.parse(fs.readFileSync(extensionsJson, 'utf8')); } catch (_) {}
  }
  if (!exts.find(e => e.identifier?.id === einsteinId)) {
    exts.push({
      identifier: { id: einsteinId },
      version: einsteinVersion,
      location: { $mid: 1, path: einsteinDest, scheme: 'file' },
      relativeLocation: `${einsteinId}-${einsteinVersion}`,
      metadata: { isApplicationScoped: false, isMachineScoped: false, isBuiltin: false,
        installedTimestamp: Date.now(), pinned: true, source: 'vsix', isPreReleaseVersion: false },
    });
    fs.writeFileSync(extensionsJson, JSON.stringify(exts));
    console.log(`Registered ${einsteinId} in extensions.json`);
  } else {
    console.log(`${einsteinId} already in extensions.json`);
  }
}

// --- Register core/services dependencies in extensions.json ---
// VS Code's dependency resolver checks extensions.json, not just the filesystem.
// If salesforcedx-vscode-core and salesforcedx-vscode-services are installed but not
// registered here, Agentforce Vibes fails its dependency check and never activates.
{
  const DEPS = [
    { id: 'salesforce.salesforcedx-vscode-core',     version: '65.13.1' },
    { id: 'salesforce.salesforcedx-vscode-services', version: '65.13.1' },
  ];
  let exts = [];
  if (fs.existsSync(extensionsJson)) {
    try { exts = JSON.parse(fs.readFileSync(extensionsJson, 'utf8')); } catch (_) {}
  }
  let changed = false;
  for (const dep of DEPS) {
    const depDir = path.join(extensionsDir, `${dep.id}-${dep.version}`);
    if (!fs.existsSync(depDir)) {
      console.log(`Dependency ${dep.id} not found at ${depDir} — skipping registration`);
      continue;
    }
    if (!exts.find(e => e.identifier?.id === dep.id)) {
      exts.push({
        identifier: { id: dep.id },
        version: dep.version,
        location: { $mid: 1, path: depDir, scheme: 'file' },
        relativeLocation: `${dep.id}-${dep.version}`,
        metadata: { isApplicationScoped: false, isMachineScoped: false, isBuiltin: false,
          installedTimestamp: Date.now(), pinned: true, source: 'vsix', isPreReleaseVersion: false },
      });
      console.log(`Registered ${dep.id} in extensions.json`);
      changed = true;
    } else {
      console.log(`${dep.id} already in extensions.json`);
    }
  }
  if (changed) fs.writeFileSync(extensionsJson, JSON.stringify(exts));
}

// --- Scratch org creation ---
// MUST run before auth copy so VS Code's user-data dir includes the scratch org's credentials.
// Scratch org rotation is the default. Set TARGET_ORG_AUTH_URL to use a specific org instead
// (target org mode) — in that case scratch org creation is skipped entirely.
;(function createScratchOrgIfRequested() {
  if (process.env.TARGET_ORG_AUTH_URL) {
    return;  // target org mode — skip scratch org creation
  }

  function sq(v) { return v.replace(/"/g, '\\"'); }

  // Set the authenticated org as Dev Hub so sf org create scratch works.
  // SFDX_AUTH_URL should be your Dev Hub auth URL in scratch org mode (the default).
  try {
    const orgRaw       = execSync('sf org display --json 2>/dev/null', { encoding: 'utf8' });
    const devHubUser   = JSON.parse(orgRaw)?.result?.username ?? '';
    if (devHubUser) {
      execSync(`sf config set target-dev-hub "${sq(devHubUser)}" --global`, { encoding: 'utf8' });
      console.log(`[scratch-org] Dev Hub set to: ${devHubUser}`);
    }
  } catch (err) {
    console.log(`[scratch-org] Could not set target-dev-hub: ${String(err.message).slice(0, 150)}`);
  }

  // Load exhausted org list (local runs only — CI deletes exhausted orgs instead)
  const exhaustedFile = path.join(projectRoot, '.ava-exhausted-orgs.json');
  let exhaustedOrgs = [];
  try { exhaustedOrgs = JSON.parse(fs.readFileSync(exhaustedFile, 'utf8')); } catch (_) {}
  const now = Date.now();
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const recentlyExhausted = new Set(
    exhaustedOrgs
      .filter(e => (now - new Date(e.exhaustedAt).getTime()) < TWENTY_FOUR_HOURS)
      .map(e => e.username)
  );

  // Reuse an existing active scratch org if one is available and not recently exhausted
  try {
    const listRaw  = execSync('sf org list --json 2>/dev/null', { encoding: 'utf8' });
    const listJson = JSON.parse(listRaw);
    const today    = new Date().toISOString().slice(0, 10);
    const scratchOrgs = listJson?.result?.scratchOrgs ?? [];
    const active   = scratchOrgs.find(o =>
      !o.isExpired && o.expirationDate && o.expirationDate > today &&
      !recentlyExhausted.has(o.username ?? o.alias)
    );
    if (active) {
      const u = active.username ?? active.alias;
      console.log(`[scratch-org] Reusing existing scratch org: ${u} (expires ${active.expirationDate})`);
      execSync(`sf config set target-org "${sq(u)}" --global`, { encoding: 'utf8' });
      return;
    }
    const exhaustedCount = scratchOrgs.filter(o =>
      !o.isExpired && recentlyExhausted.has(o.username ?? o.alias)
    ).length;
    if (exhaustedCount > 0) {
      console.log(`[scratch-org] All ${exhaustedCount} active org(s) exhausted within last 24h — creating a new one`);
    } else {
      console.log('[scratch-org] No active scratch org found — creating a new one');
    }
  } catch (err) {
    console.log(`[scratch-org] Could not check existing orgs: ${String(err.message).slice(0, 150)}`);
  }

  const duration   = process.env.SCRATCH_ORG_DURATION || '1';
  const defaultDef = path.join(sfdxProjectDir, 'config', 'project-scratch-def.json');
  let   defFile    = process.env.SCRATCH_ORG_DEF || (fs.existsSync(defaultDef) ? defaultDef : null);

  if (!defFile) {
    defFile = path.join(os.tmpdir(), `scratch-def-${Date.now()}.json`);
    fs.writeFileSync(defFile, JSON.stringify({
      orgName: 'VPR Test Scratch Org', edition: 'Developer', features: [], settings: {},
    }, null, 2));
    console.log(`[scratch-org] Using minimal inline scratch def: ${defFile}`);
  }

  console.log(`[scratch-org] Creating scratch org (duration=${duration} day(s), def=${defFile})...`);

  let createOutput = '{}';
  try {
    createOutput = execSync(
      `sf org create scratch --definition-file "${sq(defFile)}" --duration-days ${duration} --set-default --json`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000 }
    );
  } catch (err) {
    createOutput = err.stdout || '{}';
    if (err.stderr) console.log(`[scratch-org] stderr: ${String(err.stderr).slice(0, 400)}`);
  }

  let username = '';
  try {
    const parsed = JSON.parse(createOutput);
    username = parsed?.result?.username ?? parsed?.username ?? '';
  } catch (_) {
    const m = createOutput.match(/"username"\s*:\s*"([^"]+)"/);
    username = m ? m[1] : '';
  }

  if (!username) {
    try {
      const raw = execSync('sf config get target-org --json 2>/dev/null', { encoding: 'utf8' });
      username = JSON.parse(raw)?.result?.[0]?.value ?? '';
    } catch (_) {}
  }

  if (username) {
    console.log(`[scratch-org] ✓ Scratch org ready: ${username}`);
  } else {
    console.log('[scratch-org] ✗ Could not determine scratch org username — auth copy will use Dev Hub credentials');
  }
})();

// --- Auth copy ---
// Where SFDX stores your real auth tokens
const sfdxAuthDir = path.join(os.homedir(), '.sfdx');
// Where the test VS Code instance will look
const testAuthDir = path.join(projectRoot, 'test-resources/settings/User/globalStorage/salesforce.salesforcedx-vscode-core');

if (!fs.existsSync(sfdxAuthDir)) {
  console.log('No .sfdx dir found — skipping auth copy (tests may not have org access)');
} else {
  fs.mkdirSync(testAuthDir, { recursive: true });
  const files = fs.readdirSync(sfdxAuthDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const src = path.join(sfdxAuthDir, file);
    const dest = path.join(testAuthDir, file);
    fs.copyFileSync(src, dest);
    console.log(`Copied auth: ${file}`);
  }
  console.log('Auth copied successfully');
}