// @ts-nocheck
import { browser } from '@wdio/globals';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

// ── .env loader ───────────────────────────────────────────────────────────────
// Reads <repo-root>/.env and injects any missing keys into process.env.
// Variables already set in the shell always take precedence.
(function loadDotEnv() {
  const envPath = path.resolve(process.env.AVA_CONSUMER_CWD ?? path.resolve(__dirname, '../..'), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
})();

// Prevent sf/sfdx CLI from emitting ANSI color codes in --json output, which
// breaks JSON.parse when the process runs in a pseudo-TTY environment.
process.env.NO_COLOR = '1';

// ── Terminal output capture ───────────────────────────────────────────────────
// Shell-level tee: VS Code terminal is configured to source a custom rc file
// that wraps sf/sfdx/bash/node to tee all output to a known file as it streams.
// Works headlessly (no clipboard/display needed) and captures from line 1.
const AVA_CAPTURE_FILE = '/tmp/ava-cmd-output.txt';
const AVA_RC_FILE      = '/tmp/ava-shell-rc.sh';
const VSCODE_SETTINGS  = path.join(
  process.env.SFDX_PROJECT_PATH
    ? path.resolve(process.env.SFDX_PROJECT_PATH)
    : path.join(process.env.AVA_CONSUMER_CWD ?? path.resolve(__dirname, '../..'), 'sfdx-project'),
  '.vscode', 'settings.json'
);
const DEFAULT_SAFE_COMMANDS = ['sf data query', 'sf data query --use-tooling-api', 'sf org display', 'sf org list'];
const PROFILE_PREFIXES: Record<string, string> = {
  'live-analysis': 'The Salesforce org is already authenticated. Always query the live org directly using sf data query, sf org display, or similar SF CLI commands. Do not search local project files for org metadata. When querying metadata types (Flow, ApexClass, CustomObject, ApexTrigger, ApexCodeCoverageAggregate, and similar), always use --use-tooling-api (e.g. sf data query --use-tooling-api "SELECT ..."); standard data queries do not reach the metadata layer.',
  'live-metadata': 'Vibes Prompt Runner already authenticated Salesforce CLI against the org selected for this run. In scratch org mode, use the scratch org created or reused from the Dev Hub auth URL. In target org mode, use the target org authenticated from TARGET_ORG_AUTH_URL. Prefer fetching metadata from that authenticated org before relying on local project files. Use Salesforce CLI commands such as sf org display, sf org list metadata-types, sf project generate manifest --from-org, sf project retrieve preview, and sf project retrieve start as needed. Do not deploy, mutate org configuration, or change org data unless the prompt explicitly asks for it.',
};
const PROFILE_SAFE_COMMANDS: Record<string, string[]> = {
  'live-analysis': DEFAULT_SAFE_COMMANDS,
  'live-metadata': [
    ...DEFAULT_SAFE_COMMANDS,
    'sf org list metadata-types',
    'sf project generate manifest',
    'sf project retrieve preview',
    'sf project retrieve start',
  ],
};

function setupShellCapture(): void {
  // Write a bash rc file that wraps sf/sfdx to tee output to AVA_CAPTURE_FILE.
  // We always use bash (not zsh) for the capture terminal because bash supports
  // --rcfile natively; zsh does not. PIPESTATUS is also bash-specific.
  const rc = `
# AVA shell capture rc — sourced by VS Code integrated terminal (bash)
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null || true

_ava_wrap() {
  local cmd="$1"; shift
  # NODE_OPTIONS=--no-warnings suppresses oclif "(node:XXXXX) Error Plugin:" process warnings.
  # The grep -vE filter strips the "Could not find typescript" stderr lines that oclif
  # prints directly (those are plain stderr, not Node process warnings).
  NODE_OPTIONS="\${NODE_OPTIONS:+\${NODE_OPTIONS} }--no-warnings" command "$cmd" "$@" 2>&1 \
    | grep -vE '›[[:space:]]Warning:[[:space:]]Could not find typescript|›[[:space:]]devDependency\\.' \
    | tee -a "${AVA_CAPTURE_FILE}"
  return "\${PIPESTATUS[0]}"
}

sf()    { _ava_wrap sf    "$@"; }
sfdx()  { _ava_wrap sfdx  "$@"; }
`.trim();

  fs.writeFileSync(AVA_RC_FILE, rc, 'utf8');
  fs.writeFileSync(AVA_CAPTURE_FILE, '', 'utf8'); // start empty

  // Also append wrappers to ~/.bashrc so they are available in ANY bash terminal,
  // regardless of whether VS Code's terminal profile setting is honoured.
  // This is the primary mechanism on Linux/CI where Agentforce may create a terminal
  // with an explicit shellPath that bypasses VS Code's configured default profile.
  const bashrc = path.join(process.env.HOME ?? '/root', '.bashrc');
  try {
    const existing = fs.existsSync(bashrc) ? fs.readFileSync(bashrc, 'utf8') : '';
    if (!existing.includes('_ava_wrap')) {
      const wrappers = `
# AVA shell capture — injected by test runner
_ava_wrap() {
  local cmd="$1"; shift
  NODE_OPTIONS="\${NODE_OPTIONS:+\${NODE_OPTIONS} }--no-warnings" command "$cmd" "$@" 2>&1 \
    | grep -vE '›[[:space:]]Warning:[[:space:]]Could not find typescript|›[[:space:]]devDependency\.' \
    | tee -a "${AVA_CAPTURE_FILE}"
  return "\${PIPESTATUS[0]}"
}
sf()    { _ava_wrap sf    "$@"; }
sfdx()  { _ava_wrap sfdx  "$@"; }
`;
      fs.appendFileSync(bashrc, wrappers);
    }
  } catch (_) {}

  // Configure VS Code workspace terminal to use bash with our rc file.
  // --rcfile replaces ~/.bashrc, which is exactly what we want.
  const platform = process.platform;
  const shell    = platform === 'win32' ? 'cmd' : '/bin/bash';
  const args     = platform === 'win32' ? [] : ['--rcfile', AVA_RC_FILE];
  const profileName = 'ava-capture';

  let settings: Record<string, any> = {};
  try { settings = JSON.parse(fs.readFileSync(VSCODE_SETTINGS, 'utf8')); } catch (_) {}

  const profileKey   = `terminal.integrated.profiles.${platform === 'darwin' ? 'osx' : platform === 'win32' ? 'windows' : 'linux'}`;
  const defaultKey   = `terminal.integrated.defaultProfile.${platform === 'darwin' ? 'osx' : platform === 'win32' ? 'windows' : 'linux'}`;
  settings[profileKey]   = { ...(settings[profileKey] ?? {}), [profileName]: { path: shell, args } };
  settings[defaultKey]   = profileName;

  fs.mkdirSync(path.dirname(VSCODE_SETTINGS), { recursive: true });
  fs.writeFileSync(VSCODE_SETTINGS, JSON.stringify(settings, null, 4), 'utf8');
}

function readAndClearCaptureFile(): string {
  try {
    if (!fs.existsSync(AVA_CAPTURE_FILE)) return '';
    let content = fs.readFileSync(AVA_CAPTURE_FILE, 'utf8');
    fs.writeFileSync(AVA_CAPTURE_FILE, '', 'utf8'); // clear for next command
    // Strip ANSI escape sequences (colours, cursor moves, OSC strings)
    content = content
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences: ESC [ ... letter
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC sequences: ESC ] ... BEL/ST
      .replace(/\x1b[()][0-9A-Za-z]/g, '');     // character set designations
    return content.trim();
  } catch (_) { return ''; }
}

// ── Logging ───────────────────────────────────────────────────────────────────
// Logs go into <sfdx-project>/logs/ so they stay with the project being tested,
// not inside the ava repo. SFDX_PROJECT_PATH defaults to "sfdx-project".
const PROJECT_ROOT   = process.env.AVA_CONSUMER_CWD ?? path.resolve(__dirname, '../..');
const SFDX_PROJECT_DIR = process.env.SFDX_PROJECT_PATH
  ? path.resolve(process.env.SFDX_PROJECT_PATH)
  : path.join(PROJECT_ROOT, 'sfdx-project');
const LOGS_BASE      = path.join(SFDX_PROJECT_DIR, 'logs');
const RUN_TS         = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR        = path.join(LOGS_BASE, 'pending');      // moved to success/ or failure/ at end
const SCRATCH_LOG_DIR = path.join(LOGS_BASE, 'scratch-org'); // scratch defs + creds
let   LOG_FILE       = path.join(LOG_DIR, `agentforce-${RUN_TS}.log`);
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SCRATCH_LOG_DIR, { recursive: true });

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function logSection(title: string, content: string): void {
  const bar   = '═'.repeat(60);
  const block = `\n${bar}\n  ${title}\n${bar}\n${content}\n${bar}\n`;
  console.log(block);
  fs.appendFileSync(LOG_FILE, block + '\n');
}

// ── Scratch org creation ──────────────────────────────────────────────────────
// Scratch org rotation is the default. Set TARGET_ORG_AUTH_URL to use a specific org instead.
// Env vars (optional):
//   TARGET_ORG_AUTH_URL         — if set, skip scratch org creation and use this org directly
//   SCRATCH_ORG_ALIAS           — alias (default: "test-scratch-org")
//   SCRATCH_ORG_DURATION        — days (default: 1)
//   SCRATCH_ORG_DEF             — path to scratch-def JSON

// Safe shell-quote: replaces any double-quote in a value with \" so it can be
// embedded inside a double-quoted shell argument without injection risk.
function shellQuote(value: string): string {
  return value.replace(/"/g, '\\"');
}

async function assertScratchOrgIfRequired(): Promise<void> {
  if (process.env.TARGET_ORG_AUTH_URL) return;  // target org mode — guard not applicable

  const check = (): boolean => {
    try {
      const raw = execSync('sf org display --json 2>/dev/null', { encoding: 'utf8' });
      const r   = JSON.parse(raw)?.result ?? {};
      if (r.isScratch || r.devHubId) return true;
      // Allow a sandbox org used as an explicit target (e.g. imcd--majortest).
      // This check runs *after* authenticateOrg(), so the default org reflects
      // the org we just authenticated — not ambient CI state from a prior job.
      if (r.instanceUrl?.includes('.sandbox.')) return true;
      return false;
    } catch (_) { return false; }
  };

  if (check()) return;

  // Not a scratch org — try one more time to select one before aborting
  log('⚠ GUARD: Default org is not a scratch org — retrying scratch org setup');
  await createScratchOrgIfRequested();
  await authenticateOrg();

  if (check()) {
    log('✓ GUARD: Scratch org successfully set on retry');
    return;
  }

  const username = (() => { try { return JSON.parse(execSync('sf org display --json 2>/dev/null', { encoding: 'utf8' }))?.result?.username ?? 'unknown'; } catch (_) { return 'unknown'; } })();
  throw new Error(`GUARD: Default org is not a scratch org (${username}) — aborting to protect production org`);
}

async function logCurrentDefaultOrg(): Promise<void> {
  log('[default-org] Checking current default org...');
  let displayInfo = '';
  try {
    const raw  = execSync('sf org display --json 2>/dev/null', { encoding: 'utf8' });
    const json = JSON.parse(raw);
    const r    = json?.result ?? {};
    displayInfo = [
      `Username    : ${r.username                    ?? '(unknown)'}`,
      `Alias       : ${r.alias                       ?? '(none)'}`,
      `Org ID      : ${r.id                          ?? '(unknown)'}`,
      `Instance URL: ${r.instanceUrl                 ?? '(unknown)'}`,
      `Org Type    : ${r.orgType ?? r.type            ?? '(unknown)'}`,
      `Status      : ${r.connectedStatus ?? r.status ?? '(unknown)'}`,
      `Is Scratch  : ${r.isScratch || r.devHubId ? 'yes' : 'no'}`,
    ].join('\n');
  } catch (err: any) {
    displayInfo = `sf org display failed: ${(err.message ?? '').slice(0, 300)}`;
    log(`[default-org] ${displayInfo}`);
  }
  logSection('CURRENT DEFAULT ORG', displayInfo);
}

// Authenticate via SFDX_AUTH_URL (explicit or auto-derived from the local CLI session)
// then write project-local sf config so the VS Code extension picks up the right org.
//
// Priority:
//   1. SFDX_AUTH_URL env var  — set this in .env (local) or as a repo secret (CI)
//   2. Auto-derive from TARGET_ORG if already authenticated locally
//   3. Auto-derive from the current global default org
//
// For local Mac: run once to put the auth URL in .env —
//   sf org display --verbose --target-org <alias> --json | jq -r '.result.sfdxAuthUrl'
async function authenticateOrg(): Promise<void> {
  const projectRoot    = process.env.AVA_CONSUMER_CWD ?? path.resolve(__dirname, '../../');
  const sfdxProjectDir = process.env.SFDX_PROJECT_PATH
    ? path.resolve(process.env.SFDX_PROJECT_PATH)
    : path.join(projectRoot, 'sfdx-project');

  // ── Resolve auth URL ─────────────────────────────────────────────────────────
  // When a scratch org was selected this run, always derive from it — even if
  // SFDX_AUTH_URL is set in the shell env (which would otherwise silently
  // re-authenticate the wrong org and overwrite the scratch org selection).
  let authUrl = '';
  const scratchOrgHint = process.env.SCRATCH_ORG_USERNAME ?? '';

  if (scratchOrgHint) {
    log(`[auth] Scratch org selected — deriving auth from ${scratchOrgHint}`);
    try {
      const raw = execSync(`sf org display --verbose --target-org "${shellQuote(scratchOrgHint)}" --json 2>/dev/null`, { encoding: 'utf8' });
      authUrl   = JSON.parse(raw)?.result?.sfdxAuthUrl ?? '';
    } catch (_) {}
    if (!authUrl) {
      // Scratch org display failed — fall back to SFDX_AUTH_URL so CI doesn't silently skip auth
      log('[auth] ⚠ Could not derive auth from scratch org — falling back to SFDX_AUTH_URL');
      authUrl = process.env.SFDX_AUTH_URL ?? '';
    }
  } else {
    authUrl = process.env.SFDX_AUTH_URL ?? '';
    if (!authUrl) {
      const hint       = process.env.TARGET_ORG ?? '';
      const targetFlag = hint ? `--target-org "${shellQuote(hint)}"` : '';
      log(`[auth] SFDX_AUTH_URL not set — deriving from ${hint || 'current default org'}`);
      try {
        const raw = execSync(`sf org display --verbose ${targetFlag} --json 2>/dev/null`, { encoding: 'utf8' });
        authUrl   = JSON.parse(raw)?.result?.sfdxAuthUrl ?? '';
      } catch (_) {}
    }
  }

  if (!authUrl) {
    log('[auth] ✗ Could not determine SFDX_AUTH_URL — org authentication skipped');
    return;
  }

  // ── Authenticate ─────────────────────────────────────────────────────────────
  const tmpFile = `/tmp/sfdx-auth-${Date.now()}.txt`;
  let   username = '';
  try {
    fs.writeFileSync(tmpFile, authUrl, { mode: 0o600 });
    const out = execSync(
      `sf org login sfdx-url --sfdx-url-file "${tmpFile}" --set-default --json 2>/dev/null`,
      { encoding: 'utf8' }
    );
    username = JSON.parse(out)?.result?.username ?? '';
    log(`[auth] ✓ Authenticated${username ? `: ${username}` : ''} (set as global default)`);
  } catch (err: any) {
    log(`[auth] ⚠ Login failed: ${(err.message ?? '').slice(0, 200)}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }

  // Fall back: read the default that --set-default just wrote
  if (!username) {
    try {
      const raw = execSync('sf config get target-org --json 2>/dev/null', { encoding: 'utf8' });
      username  = JSON.parse(raw)?.result?.[0]?.value ?? '';
    } catch (_) {}
  }

  if (!username) {
    log('[auth] ⚠ Could not determine username — skipping project-local config');
    return;
  }

  // ── Write project-local config ────────────────────────────────────────────────
  if (fs.existsSync(sfdxProjectDir)) {
    try {
      execSync(`sf config set target-org "${shellQuote(username)}"`, { encoding: 'utf8', cwd: sfdxProjectDir });
      log(`[auth] ✓ project-local target-org → "${username}"`);
    } catch (err: any) {
      log(`[auth] ⚠ project-local config failed: ${(err.message ?? '').slice(0, 200)}`);
    }
  } else {
    log(`[auth] ⚠ sfdx-project dir not found at "${sfdxProjectDir}"`);
  }
}

async function createScratchOrgIfRequested(): Promise<void> {
  if (process.env.TARGET_ORG_AUTH_URL) {
    log('[scratch-org] TARGET_ORG_AUTH_URL set — target org mode, skipping scratch org creation');
    return;
  }

  const projectRoot    = process.env.AVA_CONSUMER_CWD ?? path.resolve(__dirname, '../../');
  const sfdxProjectDir = process.env.SFDX_PROJECT_PATH
    ? path.resolve(process.env.SFDX_PROJECT_PATH)
    : path.join(projectRoot, 'sfdx-project');

  // ── Reuse an existing active scratch org if one is available ─────────────────
  // Avoids consuming scratch org allocations on every run.
  // Skip orgs that were exhausted (hit Pro model quota) within the last 24h.
  const exhaustedFile = path.join(projectRoot, '.ava-exhausted-orgs.json');
  let exhaustedOrgs: { username: string; exhaustedAt: string }[] = [];
  try { exhaustedOrgs = JSON.parse(fs.readFileSync(exhaustedFile, 'utf8')); } catch (_) {}
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const recentlyExhausted = new Set(
    exhaustedOrgs
      .filter(e => (Date.now() - new Date(e.exhaustedAt).getTime()) < TWENTY_FOUR_HOURS)
      .map(e => e.username)
  );

  try {
    const listRaw  = execSync('sf org list --json 2>/dev/null', { encoding: 'utf8' });
    const listJson = JSON.parse(listRaw);
    const today    = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const scratchOrgs = listJson?.result?.scratchOrgs ?? [];
    const active   = scratchOrgs.find((o: any) =>
      !o.isExpired && o.expirationDate && o.expirationDate > today &&
      !recentlyExhausted.has(o.username ?? o.alias)
    );
    if (active) {
      const u = active.username ?? active.alias;
      log(`[scratch-org] Reusing existing scratch org: ${u} (expires ${active.expirationDate})`);
      execSync(`sf config set target-org "${shellQuote(u)}" --global`, { encoding: 'utf8' });
      if (fs.existsSync(sfdxProjectDir)) {
        execSync(`sf config set target-org "${shellQuote(u)}"`, { encoding: 'utf8', cwd: sfdxProjectDir });
      }
      process.env.SCRATCH_ORG_USERNAME = u;
      return;
    }
    const exhaustedCount = scratchOrgs.filter((o: any) =>
      !o.isExpired && recentlyExhausted.has(o.username ?? o.alias)
    ).length;
    if (exhaustedCount > 0) {
      log(`[scratch-org] All ${exhaustedCount} active org(s) exhausted within last 24h — creating a new one`);
    } else {
      log('[scratch-org] No active scratch org found — creating a new one');
    }
  } catch (err: any) {
    log(`[scratch-org] Could not check existing orgs: ${(err.message ?? '').slice(0, 150)}`);
  }

  const duration = process.env.SCRATCH_ORG_DURATION || '1';

  // Resolve scratch-def file
  const defaultDef  = path.join(sfdxProjectDir, 'config', 'project-scratch-def.json');
  let   defFile     = process.env.SCRATCH_ORG_DEF || (fs.existsSync(defaultDef) ? defaultDef : null);

  if (!defFile) {
    defFile = path.join(SCRATCH_LOG_DIR, `scratch-def-${RUN_TS}.json`);
    fs.writeFileSync(defFile, JSON.stringify({
      orgName: 'Test Scratch Org', edition: 'Developer', features: [], settings: {},
    }, null, 2));
    log(`[scratch-org] No scratch def found — wrote minimal inline def: ${defFile}`);
  }

  log(`[scratch-org] Creating scratch org…`);
  log(`[scratch-org]   duration = ${duration} day(s)`);
  log(`[scratch-org]   def file = ${defFile}`);

  // ── Create (no alias — we use username directly) ───────────────────────────
  let createOutput = '{}';
  try {
    createOutput = execSync(
      `sf org create scratch --definition-file "${shellQuote(defFile)}" --duration-days ${duration} --set-default --json`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (err: any) {
    createOutput = err.stdout || '{}';
    if (err.stderr) log(`[scratch-org] stderr: ${err.stderr.slice(0, 400)}`);
  }

  let username = '';
  let orgId    = '';
  try {
    const parsed = JSON.parse(createOutput);
    username = parsed?.result?.username ?? parsed?.username ?? '';
    orgId    = parsed?.result?.id       ?? parsed?.id       ?? '';
  } catch (_) {
    log('[scratch-org] ⚠ Could not parse create JSON — falling back to regex');
    const m = createOutput.match(/"username"\s*:\s*"([^"]+)"/);
    username = m ? m[1] : '';
  }

  // Fall back: read the default target-org sf just set via --set-default
  if (!username) {
    try {
      const raw = execSync('sf config get target-org --json 2>/dev/null', { encoding: 'utf8' });
      username  = JSON.parse(raw)?.result?.[0]?.value ?? '';
    } catch (_) {}
  }

  if (!username) {
    log('[scratch-org] ✗ Could not determine username — org may not have been created');
    logSection('SCRATCH ORG — raw create output', createOutput.slice(0, 1000));
    return;
  }

  process.env.SCRATCH_ORG_USERNAME = username;
  log(`[scratch-org] ✓ Scratch org created: ${username} (id: ${orgId})`);

  // ── Generate password ────────────────────────────────────────────────────────
  let password = '';
  try {
    const pwRaw  = execSync(
      `sf org generate password --target-org "${shellQuote(username)}" --json`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    password = JSON.parse(pwRaw)?.result?.password ?? '';
  } catch (err: any) {
    try { password = JSON.parse(err.stdout || '{}')?.result?.password ?? ''; } catch (_) {}
    if (!password) log(`[scratch-org] ⚠ password generation failed: ${(err.message ?? '').slice(0, 200)}`);
  }

  // ── Instance URL ─────────────────────────────────────────────────────────────
  let instanceUrl = '';
  try {
    const d  = execSync(`sf org display --target-org "${shellQuote(username)}" --json 2>/dev/null`, { encoding: 'utf8' });
    instanceUrl = JSON.parse(d)?.result?.instanceUrl ?? '';
  } catch (_) {}

  // ── Log credentials ──────────────────────────────────────────────────────────
  const credBlock = [
    `Username    : ${username}`,
    `Password    : ${password || '(not generated — see log above)'}`,
    `Org ID      : ${orgId}`,
    `Instance URL: ${instanceUrl}`,
    '',
    'To reuse this org in future runs, add to .env:',
    `TARGET_ORG=${username}`,
    '',
    'These credentials are TEMPORARY and will expire when the scratch org is deleted.',
  ].join('\n');
  logSection('🔑  SCRATCH ORG CREDENTIALS', credBlock);

  const credsFile = path.join(SCRATCH_LOG_DIR, `scratch-org-creds-${RUN_TS}.txt`);
  fs.writeFileSync(credsFile, credBlock + '\n');
  log(`[scratch-org] Credentials saved to: ${credsFile}`);

  // ── Set as default by username ────────────────────────────────────────────

  log(`[scratch-org] Setting default org → ${username}`);

  for (const [label, opts] of [
    ['global',        { env: { ...process.env } }],
    ['project-local', { env: { ...process.env }, cwd: sfdxProjectDir }],
  ] as const) {
    try {
      execSync(`sf config set target-org "${shellQuote(username)}" ${label === 'global' ? '--global' : ''}`, opts as any);
      log(`[scratch-org] ✓ ${label} target-org set to "${username}"`);
    } catch (err: any) {
      log(`[scratch-org] ⚠ ${label} config set failed: ${(err.message ?? '').slice(0, 150)}`);
    }
  }

  // ── Verify via sf org list ────────────────────────────────────────────────────
  try {
    const listRaw  = execSync('sf org list --json 2>/dev/null', { encoding: 'utf8' });
    const listJson = JSON.parse(listRaw);
    const allOrgs: any[] = [
      ...(listJson?.result?.scratchOrgs    ?? []),
      ...(listJson?.result?.nonScratchOrgs ?? []),
      ...(listJson?.result?.sandboxes      ?? []),
    ];
    const defaultOrg  = allOrgs.find(o => o.isDefaultUsername || o.defaultMarker === '(D)');
    const defaultLine = defaultOrg
      ? `✓ Default org: ${defaultOrg.alias ?? defaultOrg.username} (${defaultOrg.orgId ?? ''})`
      : `⚠ Could not confirm default — see table below`;
    const orgTable = allOrgs
      .map(o =>
        `  ${o.isDefaultUsername || o.defaultMarker === '(D)' ? '(D)' : '   '} ${(o.alias ?? '').padEnd(28)} ${o.username ?? ''}`
      )
      .join('\n');
    logSection('SF ORG LIST', `${defaultLine}\n\n${orgTable}`);
  } catch (err: any) {
    log(`[scratch-org] ⚠ sf org list failed: ${(err.message ?? '').slice(0, 200)}`);
  }
}

// ── Page text ─────────────────────────────────────────────────────────────────

async function getPageText(): Promise<string> {
  try {
    // Scroll the chat message container to the bottom before reading so that
    // virtual/windowed list implementations render the latest content into the DOM.
    await (browser.execute as any)(() => {
      const candidates = [
        document.querySelector('[class*="messages"]'),
        document.querySelector('[class*="chat"]'),
        document.querySelector('[class*="conversation"]'),
        document.querySelector('[class*="scroll"]'),
        document.getElementById('root'),
        document.body,
      ];
      for (const el of candidates) {
        if (el && el.scrollHeight > el.clientHeight) {
          el.scrollTop = el.scrollHeight;
          break;
        }
      }
    });
  } catch (_) {}
  try {
    const t = await (browser.execute as any)(
      () => (document.getElementById('root') || document.body)?.innerText ?? ''
    );
    if (t && String(t).trim()) return String(t);
  } catch (_) {}
  try { return (await $('body').getText()) || ''; } catch (_) {}
  return '';
}

// Returns the innerText of the last agent/assistant message element in the chat.
// Tries progressively broader selectors so it works across webview implementations.
// Falls back to empty string if nothing is found.
async function getLastAgentMessageText(): Promise<string> {
  try {
    const text = await (browser.execute as any)(() => {
      // Walk candidate selectors from most-specific to least-specific.
      // We want the last element that is an agent/assistant response — not a user bubble.
      const candidateSelectors = [
        // Common chat-UI patterns
        '[data-role="assistant"]',
        '[data-author="agent"]',
        '[class*="assistant"][class*="message"]',
        '[class*="agent"][class*="message"]',
        '[class*="bot"][class*="message"]',
        '[class*="response"][class*="message"]',
        // Generic message list items — take the last one that isn't the user's
        '[class*="message-list"] > *',
        '[class*="messages"] > *',
        '[class*="chat"] > *',
      ];
      for (const sel of candidateSelectors) {
        const all = Array.from(document.querySelectorAll(sel));
        if (all.length === 0) continue;
        // For role-based selectors, the last element is the last agent turn.
        // For generic selectors, skip short/empty items and take the last substantial one.
        for (let i = all.length - 1; i >= 0; i--) {
          const el = all[i] as HTMLElement;
          const t  = el.innerText?.trim() ?? '';
          if (t.length > 50) return t;
        }
      }
      return '';
    });
    if (text && String(text).trim()) return String(text).trim();
  } catch (_) {}
  return '';
}

// ── Frame helpers ─────────────────────────────────────────────────────────────

async function waitForFrame(selector: string, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = await $$(selector);
    if (frames.length > 0) {
      log(`✓ Frame found: "${selector}"`);
      await browser.switchToFrame(frames[0]);
      return true;
    }
    log(`  ... waiting for frame "${selector}"`);
    await browser.pause(1500);
  }
  return false;
}

// ── Auto-approve setup ────────────────────────────────────────────────────────
// The Agentforce panel has an "Auto-approve" dropdown with toggle items.
// We read current state first so we only click what actually needs changing,
// regardless of where we start.

function parseAutoApproveTargets(raw: string): Set<string> {
  const val = raw.trim().toLowerCase();
  if (!val || val === 'none') return new Set();
  if (val === 'all') return new Set(['read', 'edit', 'execute']);
  return new Set(val.split(',').map(s => s.trim()).filter(s => ['read', 'edit', 'execute'].includes(s)));
}

async function configureAutoApprove(targets: Set<string>): Promise<void> {
  log('  [auto-approve] opening dropdown...');

  await browser.keys('Escape');
  await browser.pause(400);

  // ── Open the dropdown (up to 3 attempts) ──────────────────────────────────
  let opened = false;
  for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
    if (attempt > 1) {
      log(`  [auto-approve] retry attempt ${attempt}…`);
      await browser.keys('Escape');
      await browser.pause(600);
    }

    for (const btn of await $$('button')) {
      try {
        const t = (await btn.getText()).trim().toLowerCase();
        if (t.startsWith('auto-approve') || t === 'auto approve settings') {
          await btn.click(); opened = true; break;
        }
      } catch (_) {}
    }

    if (!opened) {
      for (const btn of await $$('[aria-label]')) {
        try {
          const lbl = ((await btn.getAttribute('aria-label')) ?? '').toLowerCase();
          if (lbl.includes('auto-approve') || lbl.includes('auto approve')) {
            await btn.click(); opened = true; break;
          }
        } catch (_) {}
      }
    }

    if (!opened) {
      for (const el of await $$('//*[contains(text(),"Auto-approve")]')) {
        try {
          const tag = (await el.getTagName()).toLowerCase();
          log(`  [auto-approve] found element with "Auto-approve" text — tag: <${tag}>`);
          if (['button','div','span','a','label','summary'].includes(tag)) {
            await el.click(); opened = true; break;
          }
        } catch (_) {}
      }
    }
  }

  if (!opened) {
    log('  [auto-approve] dropdown button not found — options may already be visible, attempting toggles directly');
  }

  await browser.pause(opened ? 1500 : 500);

  // ── Enable the three auto-approve toggles ────────────────────────────────
  // Run unconditionally — the panel may already be expanded on load.
  // Handles both plain <input type="checkbox"> and <vscode-checkbox> custom
  // elements (shadow DOM; the inner <input> is inaccessible, click the host).

  const tryEnableToggle = async (el: WebdriverIO.Element, source: string): Promise<boolean> => {
    try {
      const tag = (await el.getTagName()).toLowerCase();
      let isOn: boolean;
      if (tag === 'input') {
        isOn = await el.isSelected();
      } else {
        const ariaChecked = await el.getAttribute('aria-checked');
        const checkedAttr  = await el.getAttribute('checked');
        isOn = ariaChecked === 'true' || checkedAttr !== null;
      }
      log(`  [auto-approve] via ${source}: ${isOn ? 'already enabled' : 'enabling'}`);
      if (!isOn) await el.click();
      return true;
    } catch (_) { return false; }
  };

  const TOGGLE_MAP: Record<string, string> = {
    read:    'read all files',
    edit:    'edit all files',
    execute: 'execute all commands',
  };
  const labelsToEnable = [...targets].map(k => TOGGLE_MAP[k]).filter(Boolean);

  let anyToggleFound = false;
  for (const targetLabel of labelsToEnable) {
    let found = false;
    log(`  [auto-approve] looking for "${targetLabel}"...`);

    // Strategy A: <vscode-checkbox> custom elements (webview-ui-toolkit, uses shadow DOM)
    if (!found) {
      for (const el of await $$('vscode-checkbox')) {
        try {
          const text = (await el.getText()).toLowerCase();
          if (text.includes(targetLabel)) {
            found = await tryEnableToggle(el, 'vscode-checkbox');
            break;
          }
        } catch (_) {}
      }
    }

    // Strategy B: standard checkbox inputs — check closest container text
    if (!found) {
      for (const input of await $$('input[type="checkbox"]')) {
        try {
          const containerText: string = await browser.execute(
            (el: any) => (el.closest('li,label,div') ?? el.parentElement)?.textContent?.toLowerCase() ?? '',
            input
          );
          if (containerText.includes(targetLabel)) {
            found = await tryEnableToggle(input, 'input[type=checkbox]');
            break;
          }
        } catch (_) {}
      }
    }

    // Strategy C: role=checkbox or role=switch
    if (!found) {
      for (const el of await $$('[role="checkbox"],[role="switch"]')) {
        try {
          const combined = (
            (await el.getText()) + ' ' + (await el.getAttribute('aria-label') ?? '')
          ).toLowerCase();
          if (combined.includes(targetLabel)) {
            found = await tryEnableToggle(el, `[role=${await el.getAttribute('role')}]`);
            break;
          }
        } catch (_) {}
      }
    }

    // Strategy D: find by visible text, search parent container for any toggle
    if (!found) {
      const words = targetLabel.split(' ').slice(0, 2).join(' ');
      const cap   = words.replace(/^\w/, c => c.toUpperCase());
      for (const el of await $$(`//*[contains(normalize-space(text()),"${words}") or contains(normalize-space(text()),"${cap}")]`)) {
        try {
          const elText = (await el.getText()).toLowerCase();
          if (!elText.includes(targetLabel)) continue;
          const container = await el.$('..');
          for (const candidate of await container.$$('input[type="checkbox"],vscode-checkbox,[role="checkbox"],[role="switch"]')) {
            found = await tryEnableToggle(candidate, 'text-adjacent toggle');
            if (found) break;
          }
          if (found) break;
        } catch (_) {}
      }
    }

    if (!found) {
      log(`  [auto-approve] could not find toggle for "${targetLabel}"`);
    } else {
      anyToggleFound = true;
    }
    await browser.pause(300);
  }

  // Debug: if nothing was found, dump all visible checkboxes/buttons so we
  // can see exactly what the UI is using.
  if (!anyToggleFound) {
    const els: string[] = [];
    for (const el of await $$('button,vscode-checkbox,[role="checkbox"],[role="switch"]')) {
      try { els.push(`<${await el.getTagName()}> "${(await el.getText()).trim().replace(/\n/g, '↵')}"`); } catch (_) {}
    }
    log(`  [auto-approve] visible buttons/checkboxes: ${els.join(', ') || '(none)'}`);
  }

  if (!opened) return;

  if (!targets.has('execute')) {
    log('  [auto-approve] skipping allowlist management (execute not in targets)');
    return;
  }

  // ── Click "Manage Safe Commands Allowlist" link ────────────────────────────
  // Target <a> tags first (it's a link), then fall back to other elements.
  // Use JS click to avoid accidentally hitting a parent toggle via coordinates.
  let clicked = false;

  // Use a non-bubbling click so the event doesn't propagate to the parent
  // "Execute Safe Commands" toggle and accidentally uncheck it.
  const clickWithoutBubble = (e: any) => {
    const evt = new MouseEvent('click', { bubbles: false, cancelable: true });
    e.dispatchEvent(evt);
  };

  // Strategy A: anchor tag whose text matches
  for (const el of await $$('a')) {
    try {
      const text = (await el.getText()).trim();
      if (text.toLowerCase().includes('manage safe commands allowlist')) {
        log(`  [auto-approve] clicking <a> (no-bubble): "${text}"`);
        await browser.execute(clickWithoutBubble, el);
        clicked = true;
        break;
      }
    } catch (_) {}
  }

  // Strategy B: any element whose own text node matches (not descendants)
  if (!clicked) {
    const xpath = '//*[normalize-space(text())="Manage Safe Commands Allowlist"]';
    for (const el of await $$(xpath)) {
      try {
        const tag = (await el.getTagName()).toLowerCase();
        log(`  [auto-approve] clicking <${tag}> (no-bubble): "${(await el.getText()).trim()}"`);
        await browser.execute(clickWithoutBubble, el);
        clicked = true;
        break;
      } catch (_) {}
    }
  }

  if (!clicked) {
    log('  [auto-approve] "Manage Safe Commands Allowlist" link not found');
    return;
  }

  // ── Edit the allowlist file that VS Code opens ─────────────────────────────
  // Switch out of the webview so we can interact with the VS Code editor.
  await browser.switchToParentFrame();
  await browser.pause(2000); // wait for the file to open and gain focus

  // Go to end of file, add a new line, type the entry, save.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await browser.keys(['Control', 'End']); // end of file (works on both platforms in VS Code)
  await browser.pause(200);
  await browser.keys('Return');
  await browser.pause(200);
  const profileName = (process.env.AVA_PROFILE ?? '').trim();
  const defaultSafeCommands = PROFILE_SAFE_COMMANDS[profileName] ?? DEFAULT_SAFE_COMMANDS;
  const envCommands = (process.env.SAFE_COMMANDS_ALLOWLIST ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const safeCommands = envCommands.length > 0 ? envCommands : defaultSafeCommands;
  await browser.keys(safeCommands.join('\n'));
  await browser.pause(200);
  await browser.keys([modifier, 's']);
  await browser.pause(500);
  log(`  [auto-approve] added ${safeCommands.length} command(s) to allowlist: ${safeCommands.join(', ')}`);

  // Re-enter the webview frames so the rest of the test can continue.
  await waitForFrame('iframe.webview.ready');
  await browser.pause(1000);
  await waitForFrame('#active-frame', 30000);
  await browser.pause(1000);
}

// ── Terminal output capture ───────────────────────────────────────────────────
// When Agentforce hits its internal terminal capture limit (~33KB), the spill
// file is truncated. This reads the full output from VS Code's xterm.js buffer
// via the select-all + copy clipboard mechanism (same as wdio-vscode-service's
// TerminalView.getText()), then extracts the relevant command output.

// ── Mode enforcement ──────────────────────────────────────────────────────────

async function ensureActMode(): Promise<void> {
  const text = await getPageText();
  if (text.includes('Switch to Act mode')) {
    log('  ... in Plan mode, switching to Act');
    for (const btn of await $$('button')) {
      try {
        if ((await btn.getText()).trim().toLowerCase() === 'act') {
          await btn.click(); await browser.pause(1500); return;
        }
      } catch (_) {}
    }
  } else {
    log('  ... already in Act mode');
  }
}

async function ensurePlanMode(): Promise<void> {
  const text = await getPageText();
  if (text.includes('Switch to Plan mode')) {
    log('  ... in Act mode, switching to Plan');
    for (const btn of await $$('button')) {
      try {
        if ((await btn.getText()).trim().toLowerCase() === 'plan') {
          await btn.click(); await browser.pause(1500); return;
        }
      } catch (_) {}
    }
  } else {
    log('  ... already in Plan mode');
  }
}

// ── Button helpers ────────────────────────────────────────────────────────────

const SKIP_LABELS = new Set([
  'plan','act','read','edit','cancel','mcp',
  'safe commands','read, edit, safe commands, mcp',
  'new task','start new task','pro model',
  'compare','restore','revert','diff','open diff','disable checkpoints',
]);

const SKIP_CONTAINS = [
  'start building smarter','switch to plan','switch to act',
  'add org context','explore your mcp','manage agentforce','auto-approve',
  'checkpoints initialization','disable checkpoints','shell integration unavailable',
];

const APPROVE_LABELS = ['run command','run','approve','accept','confirm','yes','proceed','continue','execute','allow'];
const REJECT_LABELS  = ['reject','deny','no','decline',"don't"];

function isChrome(label: string): boolean {
  if (label.includes('\n')) return true;
  const lower = label.toLowerCase();
  return SKIP_LABELS.has(lower) || SKIP_CONTAINS.some(s => lower.includes(s));
}

async function findActionButtons(): Promise<{ el: WebdriverIO.Element; label: string; lower: string }[]> {
  const result: { el: WebdriverIO.Element; label: string; lower: string }[] = [];
  for (const btn of await $$('button')) {
    try {
      const label = (await btn.getText()).trim();
      if (!label || label.length > 120 || isChrome(label)) continue;
      result.push({ el: btn, label, lower: label.toLowerCase() });
    } catch (_) {}
  }
  return result;
}

async function clickButtonByLabel(targetLower: string): Promise<boolean> {
  for (const b of await $$('button')) {
    try {
      if ((await b.getText()).trim().toLowerCase() === targetLower) { await b.click(); return true; }
    } catch (_) {}
  }
  return false;
}

async function clickStartNewTask(): Promise<boolean> {
  const xpath = '//*[normalize-space(text())="Start New Task" or normalize-space(text())="start new task"]';
  for (const el of await $$(xpath)) {
    try {
      log('  → clicking "Start New Task"');
      await browser.execute((e: any) => e.click(), el);
      return true;
    } catch (_) {}
  }
  for (const btn of await $$('button')) {
    try {
      if ((await btn.getText()).trim().toLowerCase() === 'start new task') {
        await btn.click();
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function clickRunCommand(): Promise<boolean> {
  // Try <button> elements first
  for (const b of await $$('button')) {
    try {
      const text = (await b.getText()).trim().toLowerCase();
      if (text.includes('run command') || text === 'run') {
        log(`  → clicking <button>: "${text}"`);
        await b.click();
        return true;
      }
    } catch (_) {}
  }

  // Fall back to any element whose own text node is exactly "Run Command"
  // (covers div/span/a/li used as buttons in React UIs)
  const xpath = '//*[normalize-space(text())="Run Command"]';
  for (const el of await $$(xpath)) {
    try {
      const tag = (await el.getTagName()).toLowerCase();
      if (!['script','style','head'].includes(tag)) {
        log(`  → JS-clicking <${tag}>: "Run Command"`);
        await browser.execute((e: any) => e.click(), el);
        return true;
      }
    } catch (_) {}
  }

  log('  → Run Command element not found');
  return false;
}

async function hasPendingCommand(): Promise<boolean> {
  const text = await getPageText();
  return text.includes('Pending') && (text.includes('Run Command') || text.includes('run command'));
}

async function hasAllowlistWarning(): Promise<boolean> {
  const text = await getPageText();
  return text.toLowerCase().includes('safe commands allowlist') &&
    (text.includes('Run Command') || text.includes('run command'));
}

// Broader check for any pending approval state that may not yet have a
// "Run Command" button rendered — covers "requires explicit approval" prompts
// and allowlist warnings before the Run Command button has appeared.
async function hasPendingApproval(): Promise<boolean> {
  const text = await getPageText();
  const lower = text.toLowerCase();
  return (
    (text.includes('Pending') && lower.includes('requires explicit approval')) ||
    lower.includes('safe commands allowlist')
  );
}

// Extracts the pending command text from the page text for logging.
// The UI shows: "Pending\n<command>\n...\nRun Command\nReject"
// so we grab the non-empty line immediately after "Pending".
function extractPendingCommand(text: string): string {
  // Primary: first non-empty line after standalone "Pending"
  const pendingMatch = text.match(/\bPending\b\s*\n\s*(\S[^\n]*)/);
  if (pendingMatch) return pendingMatch[1].trim();
  // Fallback: look for a recognisable CLI invocation in the text
  const cliMatch = text.match(/\b(sf |sfdx |bash |npm |node |python |git )([^\n]{5,})/);
  if (cliMatch) return (cliMatch[1] + cliMatch[2]).trim();
  return '';
}

// ── Noise stripping ───────────────────────────────────────────────────────────

function clean(rawText: string): string {
  return rawText
    .replace(/Auto-approve:[\s\S]*?(?:MCP|Cancel)/g, '')
    .replace(/Type @ for context.*$/gm, '')
    .replace(/Plan\s*\n\s*Act/g, '')
    .replace(/Let's Vibe[\s\S]*?Manage Agentforce Rules & Workflows/g, '')
    .replace(/Checkpoints initialization timed out[\s\S]*?Disable Checkpoints/g, '')
    .replace(/Shell Integration Unavailable[\s\S]*?Still having trouble\?/g, '')
    .replace(/^\s*\d+(\.\d+)?k\s*$/gm, '')
    .replace(/^\s*\d+\/\d+\s*$/gm, '')
    .replace(/^\s*0\s*$/gm, '')
    .replace(/^\s*Pro Model\s*$/gm, '')
    .replace(/^\s*Core Model\s*$/gm, '')
    .replace(/^fatal: cannot copy.*$/gm, '')
    .replace(/^\s*Start New Task\s*$/gm, '')
    .replace(/^\s*Cancel\s*$/gm, '')
    .replace(/^\s*Disable Checkpoints\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BUSY_PHRASES = [
  'thinking...','proceeding to','i will start by','i need to inspect',
  'i will search','i will list','i will check','i will look','i will read',
  'listing files','exploring ','reading ','searching ','running ',
  'executing ','querying ','retrieving ','fetching ','connecting ','authenticating ',
];

function agentIsStillWorking(text: string): boolean {
  return BUSY_PHRASES.some(p => text.toLowerCase().includes(p));
}

// Returns the first visible, interactable chat input — skips hidden Monaco overlays.
// On headless Linux the DOM order differs from macOS and the hidden aria-hidden textarea
// (Monaco's invisible input shim) appears before the real one, causing setValue to fail.
async function findChatInput(): Promise<WebdriverIO.Element | null> {
  const selectors = [
    'textarea', 'input[type="text"]', '[contenteditable="true"]',
    '[placeholder*="Ask"]', '[placeholder*="ask"]',
    '[placeholder*="Type"]', '[placeholder*="message"]',
  ];
  for (const sel of selectors) {
    for (const el of await $$(sel)) {
      try {
        if ((await el.getAttribute('aria-hidden')) === 'true') continue;
        if (!(await el.isDisplayed())) continue;
        return el;
      } catch (_) {}
    }
  }
  return null;
}

const SPINNER_SELECTOR =
  '.codicon-loading, .animate-spin, [class*="thinking"], [class*="spinner"], ' +
  '[class*="chat"][class*="loading"], [class*="message"][class*="loading"]';

async function agentIsRunning(pageText?: string): Promise<boolean> {
  // Fast path: if we already have the page text, look for an isolated "Cancel" line.
  // This avoids iterating every <button> element (expensive when there are dozens).
  if (pageText !== undefined) {
    return /(?:^|\n)\s*Cancel\s*(?:\n|$)/.test(pageText);
  }
  for (const btn of await $$('button')) {
    try { if ((await btn.getText()).trim().toLowerCase() === 'cancel') return true; } catch (_) {}
  }
  return false;
}

async function waitForAgentResponse(
  baselineText: string,
  minWaitMs = 10000,
  timeoutMs = 180000
): Promise<string> {
  const start = Date.now();
  log(`  ... waiting for agent (${minWaitMs / 1000}s floor)`);
  await browser.pause(minWaitMs);

  let lastText    = await getPageText();
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    await browser.pause(3000);

    const current = await getPageText();

    // Task completion takes priority over everything — "Start New Task" means done.
    if (
      current.toLowerCase().includes('start new task') ||
      current.toLowerCase().includes('all tasks have been completed')
    ) { log('  ... task completion detected — returning'); return current; }

    // Check for approval prompts — these must take priority over the
    // "Cancel visible" check, since Cancel stays visible while an approval is pending.
    if (await hasPendingCommand()) {
      log('  ... pending command — returning for approval'); return current;
    }

    if (await hasAllowlistWarning()) {
      log('  ... allowlist warning — returning for approval'); return current;
    }

    // Check for action buttons BEFORE agentIsRunning: when Agentforce asks a question
    // it shows option buttons alongside Cancel, which would otherwise be mistaken for
    // "agent still running" and keep the loop spinning indefinitely.
    const btns = await findActionButtons();
    if (btns.length > 0) {
      log(`  ... action buttons: [${btns.map(b => b.label).join(', ')}]`); return current;
    }

    if (await agentIsRunning(current)) {
      if (current !== lastText) {
        log(`  ... agent running, changed (+${current.length - lastText.length} chars)`);
        stableCount = 0; lastText = current;
      } else {
        log('  ... agent running (Cancel visible)');
      }
      continue;
    }

    const spinners = await $$(SPINNER_SELECTOR);

    if (spinners.length > 0) {
      log(`  ... spinner (${spinners.length})`); lastText = current; stableCount = 0; continue;
    }

    if (
      current.toLowerCase().includes('start new task') ||
      current.toLowerCase().includes('all tasks have been completed')
    ) { log('  ... task completion detected — returning'); return current; }

    const delta = current.length > lastText.length ? current.slice(lastText.length) : '';
    if (agentIsStillWorking(delta)) {
      log(`  ... mid-stream (+${delta.length} chars)`); lastText = current; stableCount = 0; continue;
    }

    if (current === lastText) {
      stableCount++;
      log(`  ... stable (${stableCount}/5) — ${current.length} chars`);
      if (stableCount >= 5) { log('  ✓ stable'); return current; }
    } else {
      log(`  ... changed (+${current.length - lastText.length} chars)`);
      stableCount = 0; lastText = current;
    }
  }

  log('  ⚠ timed out');
  return await getPageText();
}

// ── Question classifiers ──────────────────────────────────────────────────────

function isAgentQuestion(text: string): boolean {
  return text.toLowerCase().includes('agentforce has a question') ||
         text.toLowerCase().includes('has a question');
}

function isOrgQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  return isAgentQuestion(text) && lower.includes('org') &&
    (lower.includes('which') || lower.includes('alias') || lower.includes('username'));
}

function isGenericFollowUp(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.includes('?') && !isAgentQuestion(text)) return false;
  return (
    lower.includes('would you like') || lower.includes('do you want') ||
    lower.includes('please confirm')  || lower.includes('please provide') ||
    lower.includes('can you clarify') || lower.includes('could you specify') ||
    lower.includes('paste the json')  || lower.includes('paste the output')
  );
}

function diffContent(previous: string, current: string): string {
  const a = clean(previous), b = clean(current);
  return b.startsWith(a) ? b.slice(a.length).trim() : b;
}

async function handleOrgQuestion(questionText: string): Promise<void> {
  log('  [org] handling org selection');
  for (const btn of await $$('button')) {
    try {
      const label = (await btn.getText()).trim();
      const lower = label.toLowerCase();
      if (isChrome(label)) continue;
      if (lower.includes('scratch') || (lower.includes('default') && !lower.includes('dev-hub'))) {
        log(`  [org] clicking: "${label}"`);
        logSection('YOU (org selection)', `Selected: "${label}"`);
        await btn.click(); await browser.pause(1000); return;
      }
    } catch (_) {}
  }
  const m     = questionText.match(/(\w+)\s*\((?:scratch org|default scratch)/i);
  const alias = m ? m[1] : 'the default scratch org';
  const answer = `Use ${alias} — the default scratch org`;
  logSection('YOU (org selection)', answer);
  const input = await findChatInput();
  if (input) {
    await input.click();
    await input.setValue(answer);
    await browser.keys('Return');
    await browser.pause(1000);
  }
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe('Agentforce Vibes POC', () => {
  before(async function () {
    this.timeout(120000);
    log(`\nLog file: ${LOG_FILE}`);

    setupShellCapture();
    log('[shell-capture] VS Code terminal configured to tee output to capture file');

    await createScratchOrgIfRequested();
    await authenticateOrg();
    await logCurrentDefaultOrg();
    await assertScratchOrgIfRequired();

    log('Waiting for VS Code + SFDX project to load...');
    await browser.pause(8000);

    const workbench = await browser.getWorkbench();
    const controls  = await workbench.getActivityBar().getViewControls();
    let opened = false;

    for (const ctrl of controls) {
      try {
        const title = await ctrl.getTitle();
        if (title.toLowerCase().includes('agentforce') || title.toLowerCase().includes('einstein')) {
          await ctrl.openView();
          opened = true;
          log(`Opened activity bar control: "${title}"`);
          break;
        }
      } catch (_) {}
    }

    if (!opened) {
      log('Activity bar control not found — trying command palette...');
      await workbench.executeCommand('Agentforce: Focus on Agentforce View');
    }

    log('Panel opened, waiting for webview...');
    await browser.pause(15000);
  });

  it('sends a message and handles agent follow-ups interactively', async function () {
    this.timeout(600000);
    let taskCompleted = false;

    const outerOk = await waitForFrame('iframe.webview.ready');
    if (!outerOk) { log('✗ Outer frame never appeared'); return; }
    await browser.pause(2000);

    // Poll for #active-frame, periodically dispatching a synthetic controllerchange event.
    //
    // Root cause (Linux CI): VS Code's webview host page waits for the SW
    // controllerchange event before creating #active-frame.  On Linux with
    // Electron's sandboxed cross-origin iframes, navigator.serviceWorker.controller
    // becomes set (SW activates via clients.claim()) but the controllerchange event
    // is never dispatched to the page.  VS Code's { once:true } listener never fires.
    //
    // Fix: every poll iteration, check if the SW is active and dispatch a synthetic
    // controllerchange event.  VS Code's listener fires once, signals readiness to
    // the workbench, and the workbench sends the extension HTML — creating #active-frame.
    let innerOk = false;
    {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const frames = await $$('#active-frame');
        if (frames.length > 0) {
          log('✓ Frame found: "#active-frame"');
          await browser.switchToFrame(frames[0]);
          innerOk = true;
          break;
        }
        log('  ... waiting for frame "#active-frame"');
        try {
          await browser.execute(() => {
            const sw = (navigator as any).serviceWorker;
            if (sw && sw.controller) {
              sw.dispatchEvent(new Event('controllerchange'));
            }
          });
        } catch (_) {}
        await browser.pause(1500);
      }
    }
    if (!innerOk) {
      await browser.switchToParentFrame();
      throw new Error('#active-frame never appeared');
    }
    await browser.pause(3000);

    const usePlanMode = (process.env.USE_PLAN_MODE ?? '').trim() === '1';
    if (usePlanMode) {
      await ensurePlanMode();
    } else {
      await ensureActMode();
    }
    let configureTargets = parseAutoApproveTargets(process.env.CONFIGURE_AUTO_APPROVE ?? '');
    const autoApproveCommands = ['1', 'true', 'yes'].includes((process.env.AUTO_APPROVE_COMMANDS ?? '').toLowerCase());
    const safeCommandsAllowlist = (process.env.SAFE_COMMANDS_ALLOWLIST ?? '').trim();
    const profileName = (process.env.AVA_PROFILE ?? '').trim();
    const profileImpliesSafeCommands = Boolean(PROFILE_SAFE_COMMANDS[profileName]?.length);
    if ((autoApproveCommands || safeCommandsAllowlist || profileImpliesSafeCommands) && !configureTargets.has('execute')) {
      // Auto-add execute so the safe commands allowlist UI can be populated when
      // blanket auto-approve is on, the run explicitly provides safe commands,
      // or a built-in profile implies default Salesforce CLI commands.
      configureTargets = new Set([...configureTargets, 'execute']);
    }
    if (configureTargets.size > 0) {
      await configureAutoApprove(configureTargets);
    } else {
      log('  [auto-approve] CONFIGURE_AUTO_APPROVE not set — skipping initial panel setup');
    }

    await browser.pause(3000); // give the extension a moment to fully render
    const chatInput = await findChatInput();
    if (!chatInput) { log('✗ No visible chat input found'); await browser.switchToParentFrame(); return; }
    log('✓ Found chat input');

    const prompt = process.env.PROMPT;
    if (!prompt) throw new Error('PROMPT env var is required — set it in .env or pass it inline');

    const profilePrefix = profileName ? (PROFILE_PREFIXES[profileName] ?? '') : '';
    const prefix = ((process.env.PROMPT_PREFIX ?? '').trim() || profilePrefix).trim();
    const fullPrompt = prefix ? `${prefix}\n\n${prompt}` : prompt;
    logSection('YOU', fullPrompt);
    await chatInput.click();
    await browser.pause(300);
    await chatInput.setValue(fullPrompt);
    await browser.keys('Return');

    let previousText = await getPageText();
    let round = 0;
    const MAX_ROUNDS = 20;
    const splicedSpillFiles = new Set<string>(); // avoid logging the same spill file twice
    const clickedButtonLabels = new Set<string>(); // avoid re-clicking stale buttons from prior questions
    const runEvents: string[] = []; // ordered record of approvals/questions for RUN SUMMARY
    let lastApprovedCommand = '';      // command most recently auto-approved, used for terminal capture
    let pendingTerminalCapture = false; // true after a command approval — capture terminal at next round start
    let modelTier = 'unknown';   // 'pro', 'core', or 'unknown'
    let modelEverCore = false;   // true if we ever saw Core Model (hit rate limit)
    const recentResponseTexts: string[] = []; // last 3 cleaned responses for content-hash loop detection
    let lastAutoSelectedLabel = '';            // label of last auto-selected option
    let lastAutoSelectedResponseText = '';     // cleaned response at time of last auto-select
    let contentHashInterventionSent = false;   // true after first content-hash loop intervention
    let failureReason = '';                    // set on non-completion for PROMPT_OPTIMIZATION
    let awaitingInterventionResponse = false;  // true after we send an intervention — next response is diagnostic
    let interventionResponse = '';             // agent's actual response to the intervention message

    while (round < MAX_ROUNDS) {
      round++;
      log(`\n── Round ${round}`);

      if (usePlanMode) {
        await ensureActMode();
      }

      const responseText = await waitForAgentResponse(previousText);

      // ── Loop detection: track last 3 cleaned response texts ──────────────────
      {
        const r = clean(responseText);
        recentResponseTexts.push(r);
        if (recentResponseTexts.length > 3) recentResponseTexts.shift();
      }

      // ── Terminal output capture (always, after every command approval) ────────
      // The shell wrapper teed the full command output to AVA_CAPTURE_FILE as it
      // streamed. Read and clear it now — works headlessly, no clipboard needed.
      if (pendingTerminalCapture) {
        pendingTerminalCapture = false;
        const terminalOutput = readAndClearCaptureFile();
        if (terminalOutput) {
          logSection(`TERMINAL OUTPUT — Round ${round}`, terminalOutput);
          log(`[terminal] Captured ${terminalOutput.length} bytes from shell tee`);
        } else {
          log('[terminal] Capture file empty — terminal may not have used the wrapper shell yet');
        }
      }

      // ── Model tier detection ─────────────────────────────────────────────────
      // "Pro Model" / "Core Model" appear as standalone lines in the raw webview text.
      // Core = rate-limited fallback. Track changes and whether we ever hit Core.
      {
        const hasPro  = /\bPro Model\b/i.test(responseText);
        const hasCore = /\bCore Model\b/i.test(responseText);
        const detected = hasPro ? 'pro' : hasCore ? 'core' : null;
        if (detected && detected !== modelTier) {
          if (modelTier !== 'unknown') log(`⚠ Model tier changed: ${modelTier} → ${detected}`);
          modelTier = detected;
          if (detected === 'core') modelEverCore = true;
        }
      }

      const newContent   = diffContent(previousText, responseText);
      // When the agent spilled large output to a file, the webview text contains
      // noisy truncated content (sf CLI warnings + partial JSON). Skip logging it
      // here — the clean full output is captured in the LARGE OUTPUT section below.
      // Preserve any text that follows the last spill marker — that is the agent's
      // human-readable summary of what it found.
      const hasSpill = /Writing to:\s*\/[^\s]+\.log/.test(responseText);
      let roundLog: string;
      let spillSummary = '';
      if (hasSpill) {
        const base = newContent || clean(responseText);
        const spillMatches = [...base.matchAll(/Writing to:\s*(\/[^\s]+\.log)/g)];
        const lastSpill    = spillMatches[spillMatches.length - 1];
        if (lastSpill) {
          const afterSpill = base.slice(lastSpill.index! + lastSpill[0].length).trim();
          const cleaned    = clean(afterSpill);
          if (cleaned) spillSummary = cleaned;
        }
        roundLog = base.replace(/[\s\S]*?(Writing to:\s*\/[^\s]+\.log)[\s\S]*/g, '[$1 — full output below]');
      } else {
        roundLog = newContent || clean(responseText);
      }

      // Capture agent's response to an intervention message (loop diagnosis).
      if (awaitingInterventionResponse && roundLog) {
        interventionResponse = roundLog;
        awaitingInterventionResponse = false;
        log('📋 Captured agent intervention response for PROMPT_OPTIMIZATION');
      }

      // Also capture the last agent message directly from the DOM — most reliable
      // source when diffContent is confused by DOM reshuffles.
      const lastMsgText = await getLastAgentMessageText();
      logSection(`AGENTFORCE — Round ${round}`, roundLog);
      if (spillSummary) {
        logSection(`AGENTFORCE — Round ${round} (summary)`, spillSummary);
      }
      if (lastMsgText && clean(lastMsgText) !== clean(roundLog) && clean(lastMsgText) !== spillSummary) {
        logSection(`AGENTFORCE — Round ${round} (last message)`, lastMsgText);
      }

      // If Agentforce spilled large output to a temp file, splice it into the log now.
      // Message format: "Writing to: /tmp/a4d/large-output-<ts>-<id>.log"
      // Search the full responseText so we don't miss paths that were already visible
      // but track which files we've already spliced to avoid duplicates across rounds.
      for (const m of responseText.matchAll(/Writing to:\s*(\/[^\s]+\.log)/g)) {
        const spillPath = m[1];
        if (splicedSpillFiles.has(spillPath)) continue;
        splicedSpillFiles.add(spillPath);
        try {
          // Wait for the file to finish being written — poll until size is stable.
          let prevSize = -1;
          for (let i = 0; i < 10; i++) {
            await browser.pause(500);
            const size = fs.existsSync(spillPath) ? fs.statSync(spillPath).size : 0;
            if (size > 0 && size === prevSize) break;
            prevSize = size;
          }

          if (fs.existsSync(spillPath)) {
            const raw = fs.readFileSync(spillPath, 'utf8');
            // The sf CLI mixes stderr noise before the JSON when using 2>&1.
            // Extract from the first `{\n  "status"` which is how sf --json always starts.
            const jsonStart = raw.search(/^\{$/m);
            const spillContent = jsonStart !== -1 ? raw.slice(jsonStart).trim() : raw.trim();
            let isCompleteJson = false;
            try { JSON.parse(spillContent); isCompleteJson = true; } catch (_) {}
            const spillLabel = isCompleteJson
              ? `LARGE OUTPUT — ${path.basename(spillPath)}`
              : `LARGE OUTPUT (Agentforce partial capture ~${Math.round(spillContent.length / 1024)}KB) — ${path.basename(spillPath)}`;
            logSection(spillLabel, spillContent);
            log(`[large-output] Read ${spillContent.length} bytes from ${spillPath}${isCompleteJson ? '' : ' (truncated — see TERMINAL OUTPUT for full content)'}`);
          }
        } catch (e: any) {
          log(`[large-output] Could not read ${spillPath}: ${e.message}`);
        }
      }

      const autoApprove       = ['1', 'true', 'yes'].includes((process.env.AUTO_APPROVE_COMMANDS ?? '').toLowerCase());
      const autoSelectOption  = ['1', 'true', 'yes'].includes((process.env.AUTO_SELECT_OPTION   ?? '').toLowerCase());

      if (await hasPendingCommand()) {
        const pendingCmd = extractPendingCommand(responseText);
        if (!autoApprove) {
          log('✗ Command requires approval but AUTO_APPROVE_COMMANDS is not set — failing');
          runEvents.push(`Round ${round} — STOPPED: approval required for: ${pendingCmd || '(command unknown)'}`);
          logSection('STOPPED: APPROVAL REQUIRED', [
            'Agentforce requested approval to run a command.',
            pendingCmd ? `Command: ${pendingCmd}` : 'Command: (could not extract)',
            '',
            'Set AUTO_APPROVE_COMMANDS=1 in .env or pass auto_approve: true in the workflow call.',
          ].join('\n'));
          break;
        }
        log('⚡ Pending command — clicking Run Command');
        logSection('APPROVAL', [
          'Decision: AUTO-APPROVED (AUTO_APPROVE_COMMANDS=1)',
          pendingCmd ? `Command: ${pendingCmd}` : 'Command: (could not extract)',
        ].join('\n'));
        runEvents.push(`Round ${round} — APPROVAL auto-approved: ${pendingCmd || '(command unknown)'}`);
        lastApprovedCommand = pendingCmd || ''; pendingTerminalCapture = true;
        await clickRunCommand();
        await browser.pause(2000);
        previousText = await getPageText();
        continue;
      }

      if (await hasAllowlistWarning()) {
        const allowlistCmd = extractPendingCommand(responseText);
        if (!autoApprove) {
          log('✗ Command blocked by allowlist and AUTO_APPROVE_COMMANDS is not set — failing');
          runEvents.push(`Round ${round} — STOPPED: approval required (allowlist) for: ${allowlistCmd || '(command unknown)'}`);
          logSection('STOPPED: APPROVAL REQUIRED', [
            'Agentforce requested approval to run a command (blocked by safe commands allowlist).',
            allowlistCmd ? `Command: ${allowlistCmd}` : 'Command: (could not extract)',
            '',
            'Set AUTO_APPROVE_COMMANDS=1 in .env or pass auto_approve: true in the workflow call.',
          ].join('\n'));
          break;
        }
        log('⚡ Allowlist warning — AUTO_APPROVE_COMMANDS set, clicking Run Command');
        logSection('APPROVAL', [
          'Decision: AUTO-APPROVED (allowlist-blocked, AUTO_APPROVE_COMMANDS=1)',
          allowlistCmd ? `Command: ${allowlistCmd}` : 'Command: (could not extract)',
        ].join('\n'));
        runEvents.push(`Round ${round} — APPROVAL auto-approved (allowlist): ${allowlistCmd || '(command unknown)'}`);
        lastApprovedCommand = allowlistCmd || ''; pendingTerminalCapture = true;
        await clickRunCommand();
        await browser.pause(2000);
        previousText = await getPageText();
        continue;
      }

      const actionButtons = await findActionButtons();
      if (actionButtons.length > 0) {
        const labels = actionButtons.map(b => b.label).join(', ');
        log(`⚡ Action buttons: [${labels}]`);
        const fresh = actionButtons.filter(b => !clickedButtonLabels.has(b.lower));
        const approveTarget  = fresh.find(b =>
          APPROVE_LABELS.some(a => b.lower.includes(a)) &&
          !REJECT_LABELS.some(r => b.lower.includes(r))
        );
        const fallbackTarget = fresh.find(b => !REJECT_LABELS.some(r => b.lower.includes(r)));
        const target = approveTarget || fallbackTarget;
        if (target) {
          // If this is a content-choice button (not an approve-label match), gate behind AUTO_SELECT_OPTION.
          // Approve-label buttons (run, accept, confirm…) proceed regardless — they are handled like
          // command approval. Only novel option buttons require explicit opt-in.
          const optionList = fresh.map((b, i) => `  ${i + 1}. ${b.label}`).join('\n');
          if (!approveTarget && !autoSelectOption) {
            runEvents.push(`Round ${round} — STOPPED: question with ${fresh.length} options — "${fresh[0]?.label ?? '?'}"`);
            logSection('STOPPED: QUESTION', [
              'Agentforce asked a question and requires a choice to continue.',
              '',
              'Question:',
              lastMsgText ? lastMsgText.trim() : '(see AGENTFORCE round above)',
              '',
              'Options:',
              optionList,
              '',
              'To auto-select the first option: set AUTO_SELECT_OPTION=1 in .env',
              '  or pass auto_select: true in the workflow call.',
              'To avoid this question: add context to your prompt that answers it upfront.',
            ].join('\n'));
            break;
          }
          // ── Auto-select repeat loop detection ──────────────────────────────
          if (!approveTarget && target.label === lastAutoSelectedLabel && clean(responseText) === lastAutoSelectedResponseText) {
            const intervention = "I keep selecting that option but it does not seem to be helping you. Can you tell me exactly what you need or try a different approach?";
            log(`⚠ Loop detected: auto-selected "${target.label}" again with unchanged response — sending intervention`);
            runEvents.push(`Round ${round} — LOOP_INTERVENTION: repeated auto-select of "${target.label}" with no progress`);
            logSection('LOOP_INTERVENTION', [
              `Repeated auto-select of "${target.label}" detected with no change in agent response.`,
              `Sending: ${intervention}`,
            ].join('\n'));
            lastAutoSelectedLabel = '';
            lastAutoSelectedResponseText = '';
            const loopInput = await findChatInput();
            if (loopInput) {
              await loopInput.click();
              await loopInput.setValue(intervention);
              await browser.keys('Return');
              await browser.pause(1000);
            }
            awaitingInterventionResponse = true;
            previousText = await getPageText();
            continue;
          }

          log(`  → Clicking: "${target.label}"`);
          if (approveTarget) {
            runEvents.push(`Round ${round} — APPROVAL auto-approved: "${target.label}"`);
            logSection('APPROVAL', [
              `Decision: AUTO-APPROVED ("${target.label}")`,
            ].join('\n'));
            lastAutoSelectedLabel = '';
            lastAutoSelectedResponseText = '';
          } else {
            runEvents.push(`Round ${round} — QUESTION auto-selected option 1 of ${fresh.length}: "${target.label}"`);
            logSection('OPTION_SELECTED', [
              `Decision: AUTO-SELECTED option 1 of ${fresh.length} (AUTO_SELECT_OPTION=1)`,
              '',
              optionList,
              '',
              `Selected: "${target.label}"`,
            ].join('\n'));
            lastAutoSelectedLabel = target.label;
            lastAutoSelectedResponseText = clean(responseText);
          }
          for (const b of actionButtons) clickedButtonLabels.add(b.lower);
          try { await target.el.click(); } catch (_) { await clickButtonByLabel(target.lower); }
          await browser.pause(2000);
          previousText = await getPageText();
          continue;
        }
      }

      if (isOrgQuestion(newContent)) {
        await handleOrgQuestion(newContent);
        previousText = await getPageText();
        continue;
      }

      if (isGenericFollowUp(newContent)) {
        const answer = 'Please proceed using the default scratch org.';
        log('⚡ Agent follow-up');
        logSection('YOU (auto-reply)', answer);
        const input = await findChatInput();
        if (input) {
          await input.click();
          await input.setValue(answer);
          await browser.keys('Return');
          await browser.pause(1000);
        }
        previousText = await getPageText();
        continue;
      }

      const cleanedResponse = clean(responseText);
      const lowerResponse   = cleanedResponse.toLowerCase();
      if (responseText.toLowerCase().includes('start new task')) {
        log('✅ "Start New Task" button appeared — agent completed the task');
        taskCompleted = true;
        break;
      }

      if (
        lowerResponse.includes('all tasks have been completed') ||
        lowerResponse.includes('task completed')               ||
        lowerResponse.includes('task is complete')
      ) {
        log('✅ Agent signalled task complete in response text');
        taskCompleted = true;
        break;
      }

      // Final guard: stability was confirmed but the now-stable content may
      // contain a pending approval prompt (e.g. "requires explicit approval" or
      // "safe commands allowlist") that the earlier hasPendingCommand /
      // hasAllowlistWarning checks missed because "Run Command" wasn't rendered
      // yet.  Approve and continue to a new round rather than declaring done.
      if (await hasPendingApproval()) {
        if (!autoApprove) {
          log('✗ Stable content has pending approval but AUTO_APPROVE_COMMANDS is not set — failing');
          const stableFailCmd = extractPendingCommand(responseText);
          runEvents.push(`Round ${round} — STOPPED: approval required for: ${stableFailCmd || '(command unknown)'}`);
          logSection('STOPPED: APPROVAL REQUIRED', [
            'Agentforce requested approval to run a command.',
            stableFailCmd ? `Command: ${stableFailCmd}` : 'Command: (could not extract)',
            '',
            'Set AUTO_APPROVE_COMMANDS=1 in .env or pass auto_approve: true in the workflow call.',
          ].join('\n'));
          break;
        }
        log('⚡ Stable content has pending approval — clicking Run Command and continuing');
        const stableCmd = extractPendingCommand(responseText);
        runEvents.push(`Round ${round} — APPROVAL auto-approved (post-stability): ${stableCmd || '(command unknown)'}`);
        lastApprovedCommand = stableCmd || ''; pendingTerminalCapture = true;
        logSection('APPROVAL', [
          'Decision: AUTO-APPROVED (detected after stability, AUTO_APPROVE_COMMANDS=1)',
          stableCmd ? `Command: ${stableCmd}` : 'Command: (could not extract)',
        ].join('\n'));
        await clickRunCommand();
        await browser.pause(2000);
        previousText = await getPageText();
        continue;
      }

      // ── Content hash loop detection ───────────────────────────────────────────
      // If the last 3 responses are identical and we reached this point with no
      // meaningful action taken, the agent is stuck.  First attempt: send an
      // intervention asking what the agent needs.  If it's still stuck after that,
      // break and let the RUN SUMMARY + PROMPT_OPTIMIZATION sections document it.
      if (
        recentResponseTexts.length >= 3 &&
        recentResponseTexts[0] === recentResponseTexts[1] &&
        recentResponseTexts[1] === recentResponseTexts[2]
      ) {
        if (!contentHashInterventionSent) {
          const intervention = "I notice you haven't made progress in the last few rounds. Can you tell me exactly what you need to move forward, or try a completely different approach?";
          log('⚠ Content-hash loop detected — sending intervention before failing');
          runEvents.push(`Round ${round} — LOOP_INTERVENTION: response unchanged for 3 rounds — sending clarification request`);
          logSection('LOOP_INTERVENTION', [
            'Agent response unchanged for 3 consecutive rounds with no action taken.',
            `Sending: ${intervention}`,
          ].join('\n'));
          contentHashInterventionSent = true;
          recentResponseTexts.length = 0; // reset so we give it a fresh 3-round window
          const loopInput = await findChatInput();
          if (loopInput) {
            await loopInput.click();
            await loopInput.setValue(intervention);
            await browser.keys('Return');
            await browser.pause(1000);
          }
          awaitingInterventionResponse = true;
          previousText = await getPageText();
          continue;
        }
        // Second detection after intervention — give up and document for analysis.
        log('⚠ Content-hash loop persists after intervention — breaking for analysis');
        runEvents.push(`Round ${round} — LOOP_DETECTED: still no progress after intervention — task aborted`);
        failureReason = 'CONTENT_HASH_LOOP';
        break;
      }

      if (cleanedResponse === clean(previousText)) { log('✅ No new content — done'); break; }
      log('✅ Agent finished');
      break;
    }

    await browser.switchToParentFrame();

    // Log a run summary so the outcome is visible at a glance in both CLI and issue comments.
    const approvalCount = runEvents.filter(e => e.includes('APPROVAL')).length;
    const questionCount = runEvents.filter(e => e.includes('QUESTION') || e.includes('STOPPED: question')).length;
    const stoppedCount  = runEvents.filter(e => e.includes('STOPPED:')).length;
    const loopCount     = runEvents.filter(e => e.includes('LOOP_')).length;
    logSection('RUN SUMMARY', [
      `Outcome:   ${taskCompleted ? '✅ Task completed' : '❌ Task did not complete'}`,
      `Rounds:    ${round}`,
      `Approvals: ${approvalCount}  |  Questions: ${questionCount}${stoppedCount > 0 ? `  |  Stopped: ${stoppedCount}` : ''}${loopCount > 0 ? `  |  Loop events: ${loopCount}` : ''}`,
      '',
      runEvents.length > 0
        ? 'Decisions:\n' + runEvents.map(e => `  • ${e}`).join('\n')
        : 'No approvals or questions were encountered.',
    ].join('\n'));

    // On failure, log a prompt optimization section to help diagnose and improve the prompt.
    // When an intervention was sent during the run, the agent's own response is the primary
    // diagnostic — surface it verbatim so the human (or a future meta-agent) can act on it.
    if (!taskCompleted) {
      const hasLoop     = runEvents.some(e => e.includes('LOOP_'));
      const hasStopped  = runEvents.some(e => e.includes('STOPPED:'));
      const hasQuestion = runEvents.some(e => e.includes('STOPPED: question'));

      const lines: string[] = ['--- Failure Analysis ---', ''];

      if (interventionResponse) {
        // The agent told us what it needs — that's the real diagnostic.
        lines.push('Agent response to intervention:');
        lines.push('');
        lines.push(interventionResponse);
        lines.push('');
        lines.push('Use the above to update your prompt or prompt_prefix so the agent has what it needs upfront.');
      } else if (hasQuestion) {
        lines.push('Vibes Prompt Runner stopped because the agent asked a question and auto_select was not enabled or ran out of fresh options.');
        lines.push('Enable auto_select in the issue or profile, or add context to the prompt that pre-answers the agent\'s question.');
      } else if (hasStopped) {
        lines.push('The agent reached a stopping point (approval required or explicit stop command) without completing the task.');
        lines.push('Review what command or decision caused the stop — you may need to enable auto_approve or add the relevant command to the safe_commands_allowlist.');
      } else if (hasLoop) {
        lines.push('Agent got stuck in a repeating loop. No intervention response was captured.');
        lines.push(`Ran ${round} rounds without completing the task.`);
      } else {
        lines.push(`Agent ran ${round} rounds without signalling task completion.`);
        lines.push('The task may be too open-ended. Try breaking it into smaller sub-prompts.');
      }

      lines.push('');
      lines.push('To re-run with adjustments: duplicate this issue with a revised prompt or profile.');

      logSection('PROMPT_OPTIMIZATION', lines.join('\n'));
    }

    // Log final model tier so the workflow can surface it in the issue comment.
    const modelSummary = modelTier === 'unknown'
      ? 'unknown'
      : modelEverCore && modelTier !== 'core'
        ? `${modelTier} (switched to core during run — rate limit hit)`
        : modelEverCore
          ? 'core (rate limit hit — switched from pro)'
          : modelTier;
    log(`MODEL_TIER: ${modelSummary}`);

    // If the Pro model limit was hit, delete the scratch org so the next run
    // creates a fresh one with a full quota. Only applies in scratch org mode.
    const scratchUser    = process.env.SCRATCH_ORG_USERNAME ?? '';
    const usingScratchOrg = !process.env.TARGET_ORG_AUTH_URL;
    if (modelEverCore && usingScratchOrg && scratchUser) {
      if (process.env.CI) {
        // CI: delete so next run creates a fresh org
        log(`[scratch-org] Core model was used — deleting exhausted org: ${scratchUser}`);
        try {
          execSync(
            `sf org delete scratch --target-org "${shellQuote(scratchUser)}" --no-prompt`,
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
          );
          log('[scratch-org] ✓ Scratch org deleted — next run will create a fresh one');
        } catch (err: any) {
          log(`[scratch-org] ⚠ Could not delete scratch org: ${(err.message ?? '').slice(0, 200)}`);
        }
      } else {
        // Local: mark as exhausted for 24h so setup.js rotates to another org
        const exhaustedFile = path.join(process.env.AVA_CONSUMER_CWD ?? path.resolve(__dirname, '../..'), '.ava-exhausted-orgs.json');
        let list: { username: string; exhaustedAt: string }[] = [];
        try { list = JSON.parse(fs.readFileSync(exhaustedFile, 'utf8')); } catch (_) {}
        list = list.filter(e => e.username !== scratchUser);
        list.push({ username: scratchUser, exhaustedAt: new Date().toISOString() });
        fs.writeFileSync(exhaustedFile, JSON.stringify(list, null, 2));
        log(`[scratch-org] Core model was used — marked ${scratchUser} as exhausted for 24h (will rotate next run)`);
      }
    }

    // Move log from pending/ to success/ or failure/
    const outcomeDir = path.join(LOGS_BASE, taskCompleted ? 'success' : 'failure');
    fs.mkdirSync(outcomeDir, { recursive: true });
    const finalLog = path.join(outcomeDir, path.basename(LOG_FILE));
    fs.renameSync(LOG_FILE, finalLog);
    LOG_FILE = finalLog;
    console.log(`\nLog saved to: ${finalLog}`);

    // POST result to API if configured
    const apiUrl = process.env.RESULTS_API_URL;
    const apiKey = process.env.RESULTS_API_KEY;
    if (apiUrl && apiKey) {
      try {
        const res = await fetch(apiUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            timestamp: new Date().toISOString(),
            prompt,
            status:    taskCompleted ? 'success' : 'failure',
            logFile:   path.relative(LOGS_BASE, finalLog),
            group:     process.env.PROMPT_GROUP ?? null,
          }),
        });
        const json = await res.json() as any;
        if (res.ok) {
          console.log(`Result recorded (promptId: ${json.promptId}, runId: ${json.runId})`);
        } else {
          console.warn(`API responded ${res.status}: ${JSON.stringify(json)}`);
        }
      } catch (err: any) {
        console.warn(`Failed to post result to API: ${err.message}`);
      }
    }

    expect(taskCompleted).toBe(true);
  });
});
