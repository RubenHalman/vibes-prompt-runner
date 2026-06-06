import type {Options} from '@wdio/types';
import 'wdio-vscode-service';
import {fileURLToPath} from 'url';
import {dirname} from 'path';
import {homedir, platform, arch} from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {execSync} from 'child_process';

// Load .env before anything else so env vars are available for config
;(function loadDotEnv() {
  const envPath = path.resolve(process.env.AVA_CONSUMER_CWD ?? dirname(fileURLToPath(import.meta.url)), '.env');
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// PKG_ROOT: where this package lives (node_modules/vibes-prompt-runner/ when installed)
// CONSUMER_CWD: consumer's project root — .env, sfdx-project, VS Code cache live here
const PKG_ROOT     = process.env.AVA_PKG_ROOT     ?? __dirname;
const CONSUMER_CWD = process.env.AVA_CONSUMER_CWD ?? __dirname;

const VSCODE_VERSION = '1.92.0';

// Maps Node's os.platform()/os.arch() to the directory suffix used by @vscode/test-electron.
function vscodePlatformSuffix(): string {
    const p = platform();
    const a = arch();
    if (p === 'darwin') return a === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    if (p === 'win32') return 'win32-x64';
    return a === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

// Returns the path to the VS Code app's `resources/app` directory.
function vscodeAppRoot(cwd: string): string {
    const suffix = vscodePlatformSuffix();
    const base = path.join(cwd, '.wdio-vscode-service', `vscode-${suffix}-${VSCODE_VERSION}`);
    const p = platform();
    if (p === 'darwin') return path.join(base, 'Visual Studio Code.app', 'Contents', 'Resources', 'app');
    if (p === 'win32') return path.join(base, 'VSCode-win32-x64', 'resources', 'app');
    const linuxDir = suffix === 'linux-arm64' ? 'VSCode-linux-arm64' : 'VSCode-linux-x64';
    return path.join(base, linuxDir, 'resources', 'app');
}
const EXTENSIONS_DIR = process.env.EXTENSIONS_PATH
  ? path.resolve(process.env.EXTENSIONS_PATH)
  : path.join(PKG_ROOT, 'test', 'extensions');
const SFDX_PROJECT_DIR = process.env.SFDX_PROJECT_PATH
  ? path.resolve(process.env.SFDX_PROJECT_PATH)
  : path.join(CONSUMER_CWD, 'sfdx-project');
const STORAGE_PATH = path.join(homedir(), '.wdio-vscode-service', 'storage');
const DRIVER_CACHE_DIR = path.join(CONSUMER_CWD, '.wdio-vscode-service', 'browser-cache');

// Einstein is the extension under test — loaded via extensionDevelopmentPath.
const EINSTEIN_DIR = path.join(EXTENSIONS_DIR, 'salesforcedx-einstein-gpt');

function containsChromedriverBinary(dir: string): boolean {
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === 'chromedriver') return true;
            if (entry.isDirectory() && containsChromedriverBinary(fullPath)) return true;
        }
    } catch (_) {}
    return false;
}

function cleanupBrokenChromedriverCache(cacheDir: string): void {
    const chromedriverRoot = path.join(cacheDir, 'chromedriver');
    if (!fs.existsSync(chromedriverRoot)) return;

    for (const entry of fs.readdirSync(chromedriverRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const installDir = path.join(chromedriverRoot, entry.name);
        if (containsChromedriverBinary(installDir)) continue;
        fs.rmSync(installDir, { recursive: true, force: true });
        console.warn(`[wdio] Removed broken Chromedriver cache entry: ${installDir}`);
    }
}

export const config: Options.Testrunner = {
    runner: 'local',
    cacheDir: DRIVER_CACHE_DIR,
    autoCompileOpts: {
        autoCompile: true,
        tsNodeOpts: {
            project: path.join(PKG_ROOT, 'test', 'tsconfig.json'),
            transpileOnly: true,
            compilerOptions: {isolatedModules: true},
        },
    },
    specs: [path.join(PKG_ROOT, 'test', 'specs', '*.ts')],
    exclude: [],
    maxInstances: 1,
    capabilities: [
        {
            browserName: 'vscode',
            browserVersion: 'stable',
            'wdio:vscodeOptions': {
                version: VSCODE_VERSION,
                extensionPath: PKG_ROOT,
                workspacePath: SFDX_PROJECT_DIR,
                userSettings: {
                    // Prevent VS Code from auto-updating via Squirrel.Mac.
                    // Without this, VS Code replaces the pinned 1.92.0 binary mid-session,
                    // causing a version mismatch with ChromeDriver 124.
                    'update.mode': 'none',
                    'extensions.autoUpdate': false,
                    'extensions.autoCheckUpdates': false,
                },
                vscodeArgs: {
                    // CI: reduce sandboxing and shared-memory limits on headless Linux runners.
                    // disableGpu is intentionally NOT set: it kills the GPU compositor, which
                    // VS Code relies on for webview frame transitions (pending→active-frame).
                    // Electron uses bundled SWIFTSHADER (software GL) automatically on
                    // display-only runners with no physical GPU.
                    ...(platform() === 'linux' && {
                        disableDevShmUsage: true,
                        disableSetuidSandbox: true,
                    }),
                    // No --profile: named profiles have an isolated extension registry
                    // that won't see extensions installed into the global storage dir.
                    // disableExtensions overrides wdio-vscode-service's hardcoded
                    // --disable-extensions so that installed deps (core/services) can load.
                    disableExtensions: false,
                },
                storagePath: STORAGE_PATH,
            },
        },
    ],
    logLevel: process.env.COVERAGE ? 'warn' : 'info',
    bail: 0,
    waitforTimeout: 10000,
    connectionRetryTimeout: 120000,
    connectionRetryCount: 3,
    onPrepare() {
        fs.mkdirSync(DRIVER_CACHE_DIR, { recursive: true });
        cleanupBrokenChromedriverCache(DRIVER_CACHE_DIR);
        // Patch chromium/index.js now (does not require VS Code to be downloaded yet).
        // VS Code main.js is patched in onWorkerStart, which runs after the vscode service
        // downloads VS Code in its own onPrepare.
        execSync(`node "${path.join(PKG_ROOT, 'scripts', 'patch-wdio.js')}"`, { stdio: 'inherit', cwd: CONSUMER_CWD, env: process.env });
    },
    onWorkerStart() {
        const cwd = CONSUMER_CWD;
        // Guard against VS Code's auto-updater (Squirrel.Mac on macOS) silently replacing
        // the pinned binary. If the bundle version drifted, wipe the cache and throw so
        // the user re-runs `npm test` to get a clean 1.92.0.
        const vscodePkg = path.join(vscodeAppRoot(cwd), 'package.json');
        try {
            const actualVersion = JSON.parse(fs.readFileSync(vscodePkg, 'utf8')).version;
            if (actualVersion !== VSCODE_VERSION) {
                console.warn(`[wdio] VS Code auto-updated to ${actualVersion} — wiping cache to re-download ${VSCODE_VERSION}`);
                const suffix = vscodePlatformSuffix();
                fs.rmSync(path.join(CONSUMER_CWD, '.wdio-vscode-service', `vscode-${suffix}-${VSCODE_VERSION}`), { recursive: true, force: true });
                fs.rmSync(path.join(CONSUMER_CWD, '.wdio-vscode-service', 'versions.txt'), { force: true });
                fs.rmSync(path.join(CONSUMER_CWD, '.wdio-vscode-service', 'is-complete'), { force: true });
                throw new Error(`VS Code version mismatch: restart npm test to re-download ${VSCODE_VERSION}`);
            }
        } catch (e: any) {
            if (e.message?.includes('restart npm test')) throw e;
            // package.json not readable — VS Code not yet downloaded, that is fine
        }
        // macOS only: wipe any pending Squirrel update so it cannot be applied on next launch.
        if (process.platform === 'darwin') {
            const squirrelCache = path.join(homedir(), 'Library', 'Caches', 'com.microsoft.VSCode.ShipIt');
            if (fs.existsSync(squirrelCache)) {
                fs.rmSync(squirrelCache, { recursive: true, force: true });
                console.log('[wdio] Cleared Squirrel update cache to prevent VS Code auto-update');
            }
        }
        // Re-apply patches now that VS Code has been downloaded by the vscode service.
        // On macOS, patch-wdio.js also re-signs the app bundle.
        execSync(`node "${path.join(PKG_ROOT, 'scripts', 'patch-wdio.js')}"`, { stdio: 'inherit', cwd: CONSUMER_CWD, env: process.env });
    },
    services: ['vscode'],
    framework: 'mocha',
    reporters: ['spec'],
    mochaOpts: {
        ui: 'bdd',
        timeout: 600000,
    },
};
