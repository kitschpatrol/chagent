<!-- title -->

# @kitschpatrol/chagent

<!-- /title -->

<!-- badges -->

[![NPM Package @kitschpatrol/chagent](https://img.shields.io/npm/v/@kitschpatrol/chagent.svg)](https://www.npmjs.com/package/@kitschpatrol/chagent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/license/mit)
[![CI](https://github.com/kitschpatrol/chagent/actions/workflows/ci.yml/badge.svg)](https://github.com/kitschpatrol/chagent/actions/workflows/ci.yml)

<!-- /badges -->

<!-- short-description -->

**Generate and update changelogs from Git history using locally authenticated coding agents.**

<!-- /short-description -->

## Overview

Run `chagent` in a Git repository to create a changelog from its release history or
add the missing releases to an existing changelog. Between releases, it updates
`Unreleased`. Historical release sections retain their original Markdown.

The CLI and TypeScript library use your installed, authenticated Codex or Claude
Code CLI. Codex defaults to `gpt-6.1-sol` with `xhigh` reasoning effort. No separate
API key or installed agent skill is required.

Output uses the canonical [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
header and categories. Agent progress and diagnostics never become the changelog
preamble. A brief Node.js support exception is included only when released
`engines.node` ranges demonstrate an increase in the minimum requirement during
a stable minor or patch release.

## Getting started

<!-- dependencies -->

### Dependencies

- [Node.js](https://nodejs.org/) 24.16.0 or newer (specifically `^24.16.0 || >=26.3.0`)

<!-- /dependencies -->

You also need Git and one supported agent CLI on your path. Log in to that CLI
before running chagent. Optional GitHub enrichment uses an authenticated `gh`
installation and falls back to local Git when unavailable.

The adapters were exercised with Codex CLI 0.166.0 and Claude Code 2.1.311. Older
versions must support the structured-output and isolation flags used by the
adapters.

<!-- development-dependencies -->

### Development dependencies

- [pnpm](https://pnpm.io/) 12.16.1

<!-- /development-dependencies -->

<!-- install -->

### Installation

There are several ways to install @kitschpatrol/chagent depending on how you're planning to use it:

#### CLI

Run it once without installing:

```sh
npx @kitschpatrol/chagent
```

Or install it globally with npm:

```sh
npm install --global @kitschpatrol/chagent
```

#### Library

Add it to your project to import the TypeScript API. This also puts the `chagent` CLI on your project's path:

```sh
npm install @kitschpatrol/chagent
```

<!-- /install -->

## Usage

### CLI

```sh
# Automatically initialize or update the current repository.
chagent

# Review the diff, optionally edit, then accept or cancel.
chagent --interactive

# Select another installed agent CLI.
chagent --agent claude

# Preview changes without applying them.
chagent --dry-run --no-github
```

Interactive review edits temporary candidate files. After the editor exits, the
updated diff is displayed. Accepting writes exactly the saved content. Cancelling
leaves repository files unchanged. Editor selection follows `git var GIT_EDITOR`,
or `--editor`; GUI editor commands must wait, for example `code --wait`.

The default command writes changelog files without staging or committing them.

<!-- cli-help({ heading: false, headingLevel: 3 }) -->

#### Command: `chagent`

Initialize or update changelogs from repository history.

Usage:

```txt
chagent
```

| Option                  | Description                                                           | Type                                          | Default |
| ----------------------- | --------------------------------------------------------------------- | --------------------------------------------- | ------- |
| `--cwd`                 | Repository directory                                                  | `string`                                      |         |
| `--agent`               | Installed agent CLI (default: codex)                                  | `"codex"` `"claude"`                          |         |
| `--model`               | Agent model (Codex default: gpt-6.1-sol)                              | `string`                                      |         |
| `--effort`              | Reasoning effort (Codex default: xhigh)                               | `"low"` `"medium"` `"high"` `"xhigh"` `"max"` |         |
| `--interactive`<br>`-i` | Review a diff and optionally edit before writing                      | `boolean`                                     | `false` |
| `--editor`              | Editor command for interactive review; configure GUI editors to wait  | `string`                                      |         |
| `--dry-run`             | Print a diff without applying changes                                 | `boolean`                                     | `false` |
| `--amend`               | Amend a verified unpublished release commit and matching local tags   | `boolean`                                     | `false` |
| `--github`              | Enrich Git evidence using gh when available; disable with --no-github | `boolean`                                     |         |
| `--cache`               | Cache drafts and incremental state; disable with --no-cache           | `boolean`                                     |         |
| `--config`              | Configuration file path                                               | `string`                                      |         |
| `--timeout`             | Agent timeout in seconds (default: 1200)                              | `number`                                      |         |
| `--help`<br>`-h`        | Show help                                                             | `boolean`                                     |         |
| `--version`<br>`-v`     | Show version number                                                   | `boolean`                                     |         |

<!-- /cli-help -->

### Library

```ts
import { generateChangelog, writeChangelog } from '@kitschpatrol/chagent'

const plan = await generateChangelog({ cwd: '/path/to/repository' })

// Inspect plan.files or edit their `after` contents before applying them.
await writeChangelog(plan)
```

`generateChangelog` returns proposed edits, release summaries, diagnostics, and
incremental checkpoints. `writeChangelog` verifies the original file contents and
Git HEAD before applying edits. It rejects symlink destinations, rolls back a
failed series of writes, and leaves the index unchanged.

`previewChangelog(plan)` returns a unified diff.
`reviewChangelog(plan, { editor })` provides terminal review and returns an edited
plan, or `undefined` when cancelled. `amendRelease(plan)` is the explicit legacy
release integration described below. `setLogger(logger)` enables library logging;
library calls are silent by default.

Custom providers implement the exported `AgentAdapter` type and can be passed as
`agent`. Their `generate(request)` method returns `Change[]`, with canonical
categories and source IDs from `request.evidence`. Give an adapter a stable
`cacheKey` to enable reusable draft caching, and change that key when its behavior
changes. All adapter results receive the same output validation.

### Bumpp integration

Use the library callback in `bump.config.ts`:

```ts
import { createBumppHook } from '@kitschpatrol/chagent/bumpp'
import { defineConfig } from 'bumpp'

export default defineConfig({
  commit: 'Release: {version}',
  execute: createBumppHook(),
})
```

For review during releases, use `createBumppHook({ interactive: true })`. Other
options include `agent`, `model`, `effort`, `github`, `cache`, and `editor`.

Bumpp updates versions before invoking the callback. The callback generates and
reviews changelogs, stages only those files, and adds them to bumpp's explicit
commit file list. Bumpp then commits and tags the complete release. Its existing
push and publishing settings remain under your control.

Simply using `bumpp --execute chagent` does not add the new changelog to bumpp's
normal commit file list. Avoid putting changelogs in bumpp's version-replacement
`files` option: it can replace version references in historical entries.

A generation error or cancelled review stops bumpp before its commit and tag.
Bumpp's already updated version files remain available for correction or retry.
The callback requires bumpp 12.3.0 or newer and works with recursive releases.

For an existing post-bump workflow, `chagent --amend` explicitly amends an
unpublished version-only release commit and updates matching local tags. It
checks current remote refs, preserves unrelated staged work and tag annotations,
and refuses published releases, ambiguous commits, detached HEAD, and signed
tags. Signed tags need manual re-signing; the pre-commit callback avoids that
problem. Chagent itself never pushes or publishes.

### Monorepos

Workspace declarations in `pnpm-workspace.yaml` or `package.json` determine the
packages to process. Each current workspace package gets its own changelog. The
root contains repository highlights and links to package releases.

Shared-version repositories use repository versions at the root. Independently
versioned repositories use package-qualified headings such as
`@example/package@1.2.0`. Repository infrastructure changes appear in the root's
`Unreleased` section. Explicit workspace dependencies contribute relevant source
context to dependent packages. Generated build output and lockfile-only churn do
not produce feature entries.

GitHub links to package changelogs on the default branch remain usable when a root entry is
extracted for GitHub release notes.

### Configuration

Configuration is optional. A `chagent.config.ts` file can override defaults:

```ts
import { defineConfig } from '@kitschpatrol/chagent'

export default defineConfig({
  agent: 'codex',
  cache: true,
  effort: 'xhigh',
  github: true,
  maxInputChars: 80_000,
  model: 'gpt-6.1-sol',
  timeoutMs: 1_200_000,
})
```

Also supported: `chagent.config.mjs`, `chagent.config.js`, `chagent.config.json`,
or a `chagent` key in `package.json`. CLI flags override configured values.
`--config` selects a specific file.

Use `packages` and `exclude` directory globs to customize workspace discovery.
Use `tagPatterns` to select unusual release tag conventions. Templates support
`{name}` and `{version}`; defaults recognize `v1.2.3`, `1.2.3`,
`@scope/package@1.2.3`, and `@scope/package/v1.2.3`.

## History and evidence

Chagent reads reachable Git tags, commit messages, and source diffs. Local version
bumps are recognized before a tag exists. Without reliable released-version
boundaries, new changes belong to `Unreleased`; version numbers are not invented.
An existing release heading with no matching Git boundary requires its tags or a
corrected tag pattern. Shallow clones must be completed before generation.

GitHub enrichment uses release dates and commit-associated PR information.
**GitHub release-note bodies are never generation inputs.** Changelog files and
generated build output are excluded from source evidence. Existing changelog
prose is supplied only to preserve edits and avoid duplicate entries.

Agents return structured changes with evidence references. Application code owns
the header, release boundaries, Markdown insertion, and Git operations. Codex runs
with a read-only sandbox and Claude runs without built-in tools; both work in a
temporary directory containing the supplied context. Repository content is still
sent to the selected agent service, using your existing account.

Drafts and checkpoints are stored under the checkout's Git directory in
`chagent/`. They are disposable and are not committed. Completed batches can be
reused after interruptions. `--no-cache` disables reuse and persistence. Dry runs
can populate the draft cache but do not apply changelog edits.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm fix
pnpm lint
```

Tests use disposable repositories and deterministic agent substitutes. They cover
history reconstruction, incremental updates, workspace attribution, source
validation, concurrent file edits, bumpp commits, and explicit amendment.
No test pushes to a remote or publishes a release.

## Acknowledgments

The bundled instructions adapt Rebecca Rae Barton's
[release-notes skill](https://skillmd.com/skills/thatrebeccarae/release-notes).
See [third-party notices](third-party-notices.md) for provenance and licensing.

Maintained by [Eric Mika](https://ericmika.com).

<!-- contributing -->

## Contributing

[Issues](https://github.com/kitschpatrol/chagent/issues) are welcome and appreciated.

Please open an issue to discuss changes before submitting a pull request. Unsolicited PRs (especially AI-generated ones) are unlikely to be merged.

This repository uses [@kitschpatrol/shared-config](https://github.com/kitschpatrol/shared-config) (via its `ksc` CLI) for linting and formatting, plus [MDAT](https://github.com/kitschpatrol/mdat) for readme placeholder expansion.

<!-- /contributing -->

<!-- license -->

## License

[MIT](license.txt) © [Eric Mika](https://ericmika.com)

<!-- /license -->
