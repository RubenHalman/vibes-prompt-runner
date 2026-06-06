const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const zlib = require('node:zlib');

const { ensureExtensions, EXTENSION_SPECS } = require('../scripts/bootstrap-extensions');

function makeVsix(outFile, packageJson) {
  const zip = new AdmZip();
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(packageJson, null, 2)));
  zip.addFile('extension/README.md', Buffer.from(`# ${packageJson.name}\n`));
  zip.writeZip(outFile);
}

test('ensureExtensions downloads and extracts missing Salesforce VS Code extensions', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-bootstrap-test-'));
  const packageRoot = path.join(tmp, 'pkg');
  const extensionsBase = path.join(packageRoot, 'test', 'extensions');
  const wdioStorageExtensionsDir = path.join(tmp, 'wdio-storage', 'extensions');
  fs.mkdirSync(packageRoot, { recursive: true });

  const downloads = [];
  const fixtures = new Map(
    EXTENSION_SPECS.map(spec => {
      const fixture = path.join(tmp, `${spec.directoryName}.vsix`);
      makeVsix(fixture, {
        publisher: spec.publisher,
        name: spec.name,
        version: spec.version === 'latest' ? '65.99.0' : spec.version,
      });
      if (spec.name === 'salesforcedx-einstein-gpt') {
        fs.writeFileSync(fixture, zlib.gzipSync(fs.readFileSync(fixture)));
      }
      return [spec.id, fixture];
    })
  );

  await ensureExtensions({
    packageRoot,
    extensionsBase,
    wdioStorageExtensionsDir,
    downloadFile: async (url, destination, spec) => {
      downloads.push({ url, destination, id: spec.id });
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(fixtures.get(spec.id), destination);
    },
    log: () => {},
  });

  assert.deepEqual(downloads.map(d => d.id).sort(), EXTENSION_SPECS.map(s => s.id).sort());
  assert.ok(fs.existsSync(path.join(extensionsBase, 'salesforcedx-einstein-gpt', 'package.json')));
  assert.ok(fs.existsSync(path.join(wdioStorageExtensionsDir, 'salesforce.salesforcedx-vscode-core-65.13.1', 'package.json')));
  assert.ok(fs.existsSync(path.join(wdioStorageExtensionsDir, 'salesforce.salesforcedx-vscode-services-65.13.1', 'package.json')));
});
