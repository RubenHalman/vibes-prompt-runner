#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const zlib = require('zlib');
const AdmZip = require('adm-zip');

const CORE_SERVICES_VERSION = '65.13.1';

const EXTENSION_SPECS = [
  {
    id: 'salesforce.salesforcedx-einstein-gpt',
    publisher: 'salesforce',
    name: 'salesforcedx-einstein-gpt',
    version: 'latest',
    directoryName: 'salesforcedx-einstein-gpt',
    installTo: 'extensionsBase',
  },
  {
    id: 'salesforce.salesforcedx-vscode-core',
    publisher: 'salesforce',
    name: 'salesforcedx-vscode-core',
    version: CORE_SERVICES_VERSION,
    directoryName: `salesforce.salesforcedx-vscode-core-${CORE_SERVICES_VERSION}`,
    installTo: 'wdioStorageExtensionsDir',
  },
  {
    id: 'salesforce.salesforcedx-vscode-services',
    publisher: 'salesforce',
    name: 'salesforcedx-vscode-services',
    version: CORE_SERVICES_VERSION,
    directoryName: `salesforce.salesforcedx-vscode-services-${CORE_SERVICES_VERSION}`,
    installTo: 'wdioStorageExtensionsDir',
  },
];

function marketplaceUrl(spec) {
  return `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${spec.publisher}/vsextensions/${spec.name}/${spec.version}/vspackage`;
}

function defaultPaths(options = {}) {
  const packageRoot = options.packageRoot || process.env.AVA_PKG_ROOT || path.resolve(__dirname, '..');
  const extensionsBase = options.extensionsBase || (process.env.EXTENSIONS_PATH
    ? path.resolve(process.env.EXTENSIONS_PATH)
    : path.join(packageRoot, 'test', 'extensions'));
  const wdioStorageExtensionsDir = options.wdioStorageExtensionsDir
    || path.join(os.homedir(), '.wdio-vscode-service', 'storage', 'extensions');
  return { packageRoot, extensionsBase, wdioStorageExtensionsDir };
}

function installDestination(spec, paths) {
  return spec.installTo === 'extensionsBase'
    ? path.join(paths.extensionsBase, spec.directoryName)
    : path.join(paths.wdioStorageExtensionsDir, spec.directoryName);
}

function vsixPath(spec, paths) {
  return path.join(paths.extensionsBase, `${spec.name}.vsix`);
}

async function downloadFile(url, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'Accept': 'application/octet-stream',
        'User-Agent': 'ava-vibes-prompt-runner',
      },
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        downloadFile(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`Download failed (${response.statusCode}) for ${url}`));
        return;
      }
      const out = fs.createWriteStream(destination);
      response.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    request.on('error', reject);
  });
}

function zipBytesFromMaybeGzip(vsixFile) {
  const bytes = fs.readFileSync(vsixFile);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return zlib.gunzipSync(bytes);
  }
  return bytes;
}

function extractExtension(vsixFile, destination) {
  const zip = new AdmZip(zipBytesFromMaybeGzip(vsixFile));
  const tempDir = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  zip.extractAllTo(tempDir, true);
  const extracted = path.join(tempDir, 'extension');
  if (!fs.existsSync(path.join(extracted, 'package.json'))) {
    throw new Error(`VSIX ${vsixFile} did not contain extension/package.json`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(extracted, destination);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function ensureExtensions(options = {}) {
  const paths = defaultPaths(options);
  const fetchFile = options.downloadFile || downloadFile;
  const log = options.log || console.log;

  fs.mkdirSync(paths.extensionsBase, { recursive: true });
  fs.mkdirSync(paths.wdioStorageExtensionsDir, { recursive: true });

  for (const spec of EXTENSION_SPECS) {
    const destination = installDestination(spec, paths);
    if (fs.existsSync(path.join(destination, 'package.json'))) {
      log(`[extensions] ${spec.id} already installed at ${destination}`);
      continue;
    }

    const archive = vsixPath(spec, paths);
    if (!fs.existsSync(archive)) {
      const url = marketplaceUrl(spec);
      log(`[extensions] Downloading ${spec.id} from Visual Studio Marketplace`);
      await fetchFile(url, archive, spec);
    } else {
      log(`[extensions] Using cached VSIX for ${spec.id}: ${archive}`);
    }

    log(`[extensions] Extracting ${spec.id} to ${destination}`);
    extractExtension(archive, destination);
  }

  return paths;
}

async function main() {
  await ensureExtensions();
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[extensions] ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  EXTENSION_SPECS,
  CORE_SERVICES_VERSION,
  defaultPaths,
  ensureExtensions,
  marketplaceUrl,
};
