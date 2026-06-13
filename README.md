# Vibes Prompt Runner

Run Agentforce Vibes prompts against Salesforce orgs from GitHub Actions or your terminal.

Vibes Prompt Runner opens a real VS Code session, starts the Agentforce Vibes extension, sends it your prompt, watches the run, captures logs, and can post the result back to GitHub. It is meant for teams that want repeatable Salesforce checks instead of one-off manual Agentforce sessions.

## What you can use it for

- Run a prompt whenever someone opens or labels a GitHub issue.
- Run scheduled Salesforce health checks with GitHub Actions cron.
- Ask Agentforce to inspect a Salesforce org and return a written report.
- Let Agentforce run approved Salesforce CLI commands in a controlled test harness.
- Save the full terminal/log output from each run so you can debug what happened.

Example prompts:

```text
Check this org for obvious configuration risks. Use read-only Salesforce CLI commands and summarize anything that needs follow-up.
```

```text
Retrieve flow metadata from the authenticated org, inspect active flows, and report flows that look overly complex or risky.
```

```text
Run this query and explain the result: sf data query -q "SELECT Id, Name FROM Account LIMIT 5" --json
```

## How it works in one minute

Vibes Prompt Runner uses WebdriverIO to drive VS Code like a browser. Inside VS Code it loads Agentforce Vibes and the Salesforce VS Code extensions. Your prompt goes into Agentforce, and the runner watches for output, command approvals, questions, failures, and logs.

You can run against either:

- a target org, for predictable tests against the same org every time, or
- a Dev Hub auth URL, where the runner creates/reuses scratch orgs for isolated CI runs.

For GitHub Actions, you normally add one secret (`TARGET_ORG_AUTH_URL` or `SFDX_AUTH_URL`) and call the reusable workflow in this repo.

## Quick start: GitHub Actions

This is the easiest path for most users.

### 1. Add a Salesforce auth secret

In the repo where you want to run prompts, go to:

Settings -> Secrets and variables -> Actions -> New repository secret

Choose one mode:

| Mode | Secret | Use when |
|---|---|---|
| Target org | `TARGET_ORG_AUTH_URL` | You want every run to use the same sandbox/dev org. Best for first tests. |
| Scratch org rotation | `SFDX_AUTH_URL` | You want isolated runs created from a Dev Hub. Best for CI once things are stable. |

To get an auth URL:

```sh
sf org display --verbose --target-org <your-org-alias> --json | jq -r '.result.sfdxAuthUrl'
```

Treat auth URLs like passwords. Do not commit them.

### 2. Add a workflow

Create `.github/workflows/run-vpr.yml` in your repo:

```yaml
name: Run Vibes Prompt Runner

on:
  workflow_dispatch:
    inputs:
      prompt:
        description: "Prompt to send to Agentforce"
        required: true
        type: string

permissions:
  contents: write
  issues: write

jobs:
  run:
    uses: RubenHalman/vibes-prompt-runner/.github/workflows/ava-engine.yml@main
    with:
      prompt: ${{ inputs.prompt }}
      ava_profile: live-analysis
      auto_approve: true
      auto_select: true
    secrets:
      TARGET_ORG_AUTH_URL: ${{ secrets.TARGET_ORG_AUTH_URL }}
      CALLER_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Then run it from the Actions tab with a prompt.

### 3. Start with read-only prompts

Good first prompt:

```text
Run a read-only Salesforce org health check. Use Salesforce CLI queries where useful. Do not modify data or metadata. Summarize risks and recommended follow-up.
```

Once that works, you can move to issue-triggered workflows or scheduled prompts.

## Scheduled prompts

Copy `examples/scheduled-workflow.yml` into a consuming repo as `.github/workflows/scheduled-vpr.yml`, then edit the cron and prompt.

Minimal example:

```yaml
name: Scheduled Vibes Prompt Runner Prompt

on:
  schedule:
    - cron: "0 13 * * 1-5" # weekdays at 13:00 UTC
  workflow_dispatch:

permissions:
  contents: write
  issues: write

jobs:
  scheduled-vpr:
    uses: RubenHalman/vibes-prompt-runner/.github/workflows/ava-engine.yml@main
    with:
      prompt: "Run a daily Salesforce org health check and summarize risks."
      ava_profile: live-analysis
      auto_approve: true
      auto_select: true
    secrets:
      TARGET_ORG_AUTH_URL: ${{ secrets.TARGET_ORG_AUTH_URL }}
      CALLER_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

GitHub cron uses UTC and may run a few minutes late. Keep `workflow_dispatch` in the file so you can test the scheduled prompt manually.

## Issue-triggered prompts

If you want users to open an issue and have Vibes Prompt Runner answer it, copy:

- `examples/caller-workflow.yml` to `.github/workflows/run-vpr.yml`
- `examples/vpr-run.md` to `.github/ISSUE_TEMPLATE/vpr-run.md`

The example workflow looks for the `ava-run` label. That label name is legacy but intentionally kept for compatibility. Create these labels in the consuming repo:

- `ava-run`
- `ava-pending`
- `ava-success`
- `ava-failed`

Then open an issue using the template, write the prompt, and add the `ava-run` label.

## Local CLI usage

Use local runs when you are developing the runner or testing a prompt before putting it in CI.

### From a repo checkout

```sh
git clone https://github.com/RubenHalman/vibes-prompt-runner.git
cd vibes-prompt-runner
npm install
node bin/vpr.js --help
```

Create `.env`:

```sh
TARGET_ORG_AUTH_URL=force://PlatformCLI::your-token@your-org.my.salesforce.com
PROMPT='Run this query: sf data query -q "SELECT Id FROM Account LIMIT 1" --json'
AUTO_APPROVE_COMMANDS=1
AUTO_SELECT_OPTION=1
```

Bootstrap the required VS Code extensions:

```sh
node bin/vpr.js bootstrap
```

Run it:

```sh
node bin/vpr.js
```

### As an npm CLI

After the beta is published:

```sh
npm install -g vibes-prompt-runner@beta
vpr --help
vpr bootstrap
vpr
```

For the first public beta this resolves to package version `0.1.0-beta.1`.

The CLI reads `.env` from the directory where you run `vpr`. That directory is treated as the consumer project root. Logs and generated run artifacts are written there, not inside the installed npm package.

## Configuration

### Required authentication

Set exactly one of these:

| Variable | Description |
|---|---|
| `TARGET_ORG_AUTH_URL` | Auth URL for a specific org. Best for first tests and predictable scheduled runs. |
| `SFDX_AUTH_URL` | Dev Hub auth URL. The runner creates or reuses scratch orgs for isolated runs. |

### Prompt and behavior

| Variable / input | Default | Description |
|---|---:|---|
| `PROMPT` / `prompt` | required | The prompt sent to Agentforce. |
| `AUTO_APPROVE_COMMANDS` / `auto_approve` | `0` / `false` | Auto-click Agentforce command approval prompts. Use carefully. |
| `AUTO_SELECT_OPTION` / `auto_select` | `0` / `false` | Pick the first option when Agentforce asks a question. Useful for unattended runs. |
| `AVA_PROFILE` / `ava_profile` | empty | Built-in prompt guidance. Current useful values: `live-analysis`, `live-metadata`. |
| `SAFE_COMMANDS_ALLOWLIST` / `safe_commands_allowlist` | profile default | Pre-seed Agentforce's safe command allowlist. |
| `SFDX_PROJECT_PATH` | `sfdx-project` | Workspace opened in VS Code. Override to point at a real Salesforce project. |
| `SCRATCH_ORG_DURATION` | `1` | Scratch org lifetime in days when using `SFDX_AUTH_URL`. |

`AVA_PROFILE` keeps its legacy name for now. Renaming it would break existing workflows.

## Safety notes

Vibes Prompt Runner can approve commands for Agentforce. That is powerful and risky.

For unattended runs:

- Start with a sandbox or scratch org.
- Use read-only prompts first.
- Prefer `live-analysis` for org inspection.
- Keep command approval off until you know what the prompt will do.
- If you enable auto-approval, make the prompt explicit about what commands are allowed.

## Requirements

Local runs need:

- Node 20
- Salesforce CLI (`sf`)
- an authenticated Salesforce org or auth URL
- `unzip`
- a display for VS Code; on headless Linux use Xvfb

GitHub Actions runs install the needed system dependencies in the reusable workflow.

## Troubleshooting

### The run asks for input and then fails

Set `auto_select: true` / `AUTO_SELECT_OPTION=1`, or make the prompt answer the likely question up front.

### Agentforce asks for command approval

Set `auto_approve: true` in GitHub Actions or `AUTO_APPROVE_COMMANDS=1` locally. Only do this for prompts you trust.

### GitHub Actions says no auth secret is set

Add either `TARGET_ORG_AUTH_URL` or `SFDX_AUTH_URL` under Settings -> Secrets and variables -> Actions. The target org path is simpler for the first run.

### VS Code fails on Linux with `DevToolsActivePort file doesn't exist`

This is usually an Electron sandbox/display issue. The reusable workflow already handles it on `ubuntu-latest`. For your own Linux host, run under Xvfb:

```sh
xvfb-run --auto-servernum npm test
```

### A local macOS run says VS Code is damaged

Delete `.wdio-vscode-service/` and rerun. The setup patches and re-signs the downloaded VS Code bundle automatically.

## What is included in this repo

```text
.github/workflows/ava-engine.yml    reusable GitHub Actions workflow
bin/vpr.js                          CLI entrypoint
examples/caller-workflow.yml         issue-triggered workflow example
examples/scheduled-workflow.yml      cron workflow example
examples/vpr-run.md                  issue template example
scripts/bootstrap-extensions.js      downloads Salesforce VS Code extensions
scripts/setup.js                     prepares auth, workspace, extensions, scratch orgs
scripts/patch-wdio.js                patches WebdriverIO/VS Code launch quirks
test/specs/test.e2e.ts               WebdriverIO runner that drives Agentforce
wdio.conf.mts                        VS Code/WebdriverIO config
```

## Maintainer notes

This section is intentionally lower in the README. Most users do not need it, but it explains why the harness is shaped the way it is.

### Public beta release checklist

For `0.1.0-beta.1`:

1. Confirm CI is green on `main`.
2. Make `RubenHalman/vibes-prompt-runner` public.
3. Run one real consumer-repo workflow using `TARGET_ORG_AUTH_URL` against a sandbox or test org.
4. Run `npm publish --dry-run` from a clean checkout.
5. Publish the beta package with `npm publish --tag beta`.
6. Create and push the matching git tag: `v0.1.0-beta.1`.
7. Verify `npm install -g vibes-prompt-runner@beta` and `vpr --help` from a clean machine or temp project.

### Dependency versions

| Component | Version | Pinned? | Source |
|-----------|---------|---------|--------|
| VS Code | `1.92.0` | Yes | `wdio.conf.mts` |
| Agentforce (`salesforcedx-einstein-gpt`) | `latest` | No | `scripts/bootstrap-extensions.js` |
| salesforcedx-vscode-core | `65.13.1` | Yes | `scripts/bootstrap-extensions.js` |
| salesforcedx-vscode-services | `65.13.1` | Yes | `scripts/bootstrap-extensions.js` |
| Salesforce CLI (`@salesforce/cli`) | `latest` | No | `ava-engine.yml` |
| Node.js | `20.19.5` local / `20` CI | Partial | `package.json` |
| WebdriverIO packages | lockfile versions | Yes | `package-lock.json` |

Agentforce and Salesforce CLI are pulled as `latest` on CI runs. If something breaks without a code change, check those first.

### Why the extension setup is weird

`wdio-vscode-service` launches a real VS Code instance. The Salesforce extensions have to be installed as normal extensions before VS Code starts; loading them only through `--extension-development-path` does not trigger the activation events Agentforce needs.

The runner also patches a few VS Code/WebdriverIO launch details:

- it keeps installed extensions enabled,
- strips Chrome-only flags that VS Code does not understand,
- pins VS Code to avoid ChromeDriver mismatches,
- disables the macOS Squirrel updater cache,
- re-signs the patched VS Code app bundle on macOS.

These details are mostly invisible to users, but they are why a simple headless browser test is not enough here.

## Status reporting

The reusable workflow exits successfully so it can always post logs and labels back to GitHub. The actual Agentforce result is captured separately in the run output, comments, and legacy labels such as `ava-success` or `ava-failed`.
