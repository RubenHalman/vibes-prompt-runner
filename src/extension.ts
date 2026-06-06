import type * as vscode from 'vscode';

// Vibes Prompt Runner is not a user-facing VS Code extension. WebdriverIO's VS Code service
// requires an extensionDevelopmentPath with a valid extension entrypoint, while
// Vibes Prompt Runner's actual behavior lives in test/specs/test.e2e.ts and is launched by the
// CLI through wdio.conf.mts. Keep this entrypoint intentionally inert.
export function activate(_context: vscode.ExtensionContext): void {}

export function deactivate(): void {}
