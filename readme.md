# chagent

<!-- badges -->

[![NPM Package @kitschpatrol/chagent](https://img.shields.io/npm/v/@kitschpatrol/chagent.svg)](https://www.npmjs.com/package/@kitschpatrol/chagent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/license/mit)
[![CI](https://github.com/kitschpatrol/chagent/actions/workflows/ci.yml/badge.svg)](https://github.com/kitschpatrol/chagent/actions/workflows/ci.yml)

<!-- /badges -->

<!-- short-description -->

**Changelog agent. CLI tool and TypeScript library to generate and update changelogs with a little help from your LLMs.**

<!-- /short-description -->

## Overview

Run `chagent` in a Git repository to either create a changelog where none previously existed, or update an existing changelog to capture recent changes.

Projects can use any language or build system. Version tags supply release boundaries; `package.json` is optional. Codex or Claude inspects historical commits and files directly to decide what belongs in each release.

Between releases, it will add changes under the `Unreleased` heading. Historical release sections retain their original Markdown.

Initialization reconstructs the complete reachable release history, including the initial release's capabilities and meaningful documentation, dependency, compatibility, build, test, and CI changes. Releases containing only maintenance still receive useful descriptions.

Codex and Claude research missing releases together in one session, sharing their understanding of the project across versions and packages. Very large histories split into additional sessions only when their release context exceeds the input budget. Ordinary single-release updates use one request.

The CLI and TypeScript library use your installed, authenticated Codex or Claude Code CLI. Codex defaults to `gpt-6.1-sol`; Claude defaults to [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview) (`claude-opus-5-5`). Both use `xhigh` reasoning effort by default. No separate API key or installed agent skill is required.

Output uses the canonical [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) header and extends its six standard categories with `Documentation` and `Maintenance`. The standard headings describe user-facing concerns, including public APIs and runtime compatibility; the extensions also capture documentation and internal development work.

| Heading         | Covers                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Added`         | New user-facing features and public APIs.                                                                                                                                                                    |
| `Changed`       | Changes to existing user-facing functionality, public APIs, or runtime support.                                                                                                                              |
| `Deprecated`    | Features and public APIs scheduled for removal.                                                                                                                                                              |
| `Removed`       | Removed features and public APIs.                                                                                                                                                                            |
| `Fixed`         | Bugs affecting users or library consumers.                                                                                                                                                                   |
| `Security`      | Vulnerability fixes affecting users or library consumers.                                                                                                                                                    |
| `Documentation` | All documentation changes, including guides, examples, API documentation, and help text.                                                                                                                     |
| `Maintenance`   | Other changes without a user-facing feature change, bug fix, vulnerability fix, or documentation change, including routine dependency updates, internal refactoring, builds, tests, CI, and release tooling. |

Categories follow the impact of a change. A dependency update that fixes a user-facing bug belongs under `Fixed`, while a routine dependency refresh or a fix to development tooling belongs under `Maintenance`. Documentation-only corrections belong under `Documentation`.

You can invoke it directly, or easily integrate it with a [bumpp](https://github.com/antfu-collective/bumpp)-powered release workflow.

Future versions might offer more in the way of CI integration.

## Getting started

<!-- dependencies -->

### Dependencies

- [Node.js](https://nodejs.org/) 24.16.0 or newer (specifically `^24.16.0 || >=26.3.0`)

<!-- /dependencies -->

You also need Git and one supported agent CLI on your path. Log in to that CLI before running chagent. Optional GitHub enrichment uses an authenticated `gh` installation and falls back to local Git when unavailable.

The adapters were exercised with Codex CLI 0.166.0 and Claude Code 2.1.311. Older versions must support the structured-output and isolation flags used by the adapters.

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

### CLI usage

Use `--model` and `--effort` to override the selected agent's defaults.

Explicit CLI flags override repository configuration, which overrides built-in defaults. The defaults shown in `--help` apply when no repository override is configured; the model default depends on the selected agent.

Interactive review edits temporary candidate files. After the editor exits, the updated diff is displayed. Accepting writes exactly the saved content. Cancelling leaves repository files unchanged. Editor selection follows `git var GIT_EDITOR`, or `--editor`; GUI editor commands must wait, for example `code --wait`.

The default command writes changelog files without staging or committing them.

Use `chagent --rebuild --interactive` to reconstruct an existing changelog from history and review the replacement. This explicitly replaces historical prose, including manual edits; ordinary runs preserve it. Use `--rebuild --dry-run` to preview the reconstruction without writing files. In a monorepo, rebuilding covers both package changelogs and the root summary.

<!-- cli-help -->

#### Commands

##### Command: `chagent`

Initialize or update changelogs from repository history.

Usage:

```txt
chagent
```

| Option                  | Description                                                           | Type                                          | Default                                       |
| ----------------------- | --------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| `--cwd`                 | Repository directory                                                  | `string`                                      | current directory                             |
| `--agent`               | Installed agent CLI                                                   | `"codex"` `"claude"`                          | `codex`                                       |
| `--model`               | Agent model                                                           | `string`                                      | gpt-6.1-sol (Codex); claude-opus-5-5 (Claude) |
| `--effort`              | Reasoning effort                                                      | `"low"` `"medium"` `"high"` `"xhigh"` `"max"` | `xhigh`                                       |
| `--interactive`<br>`-i` | Review a diff and optionally edit before writing                      | `boolean`                                     | `false`                                       |
| `--editor`              | Editor command for interactive review; configure GUI editors to wait  | `string`                                      | git var GIT_EDITOR                            |
| `--dry-run`             | Print a diff without applying changes                                 | `boolean`                                     | `false`                                       |
| `--rebuild`             | Reconstruct all history, replacing existing release text              | `boolean`                                     | `false`                                       |
| `--amend`               | Amend a verified unpublished release commit and matching local tags   | `boolean`                                     | `false`                                       |
| `--github`              | Enrich Git evidence using gh when available; disable with --no-github | `boolean`                                     | `true`                                        |
| `--cache`               | Cache drafts and incremental state; disable with --no-cache           | `boolean`                                     | `true`                                        |
| `--config`              | Configuration file path                                               | `string`                                      | auto-detected from repository root            |
| `--timeout`             | Agent timeout in seconds                                              | `number`                                      | `1200`                                        |
| `--help`<br>`-h`        | Show help                                                             | `boolean`                                     |                                               |
| `--version`<br>`-v`     | Show version number                                                   | `boolean`                                     |                                               |

<!-- /cli-help -->

#### CLI Examples

```sh
# Automatically initialize or update the current repository.
chagent

# Review the diff, optionally edit, then accept or cancel.
chagent --interactive

# Reconstruct an existing changelog and review its replacement.
chagent --rebuild --interactive

# Select Claude Opus 5.5 with xhigh effort.
chagent --agent claude

# Preview changes without applying them.
chagent --dry-run --no-github
```

### Library

#### API

`generateChangelog` returns proposed edits, release summaries, diagnostics, and incremental checkpoints. `writeChangelog` verifies the original file contents and Git HEAD before applying edits. It rejects symlink destinations, rolls back a failed series of writes, and leaves the index unchanged.

`previewChangelog(plan)` returns a unified diff. `reviewChangelog(plan, { editor })` provides terminal review and returns an edited plan, or `undefined` when cancelled. `amendRelease(plan)` is the explicit post-bump release integration described below. `setLogger(logger)` enables library logging; library calls are silent by default.

Custom providers implement the exported `AgentAdapter` type and can be passed as `agent`. Their `generate(request)` method receives a `GenerationRequest` with one or more `releases` to research together, the local `repositoryRoot`, and run `settings`. Each release identifies its package, scope, mode, Git refs, and a bounded starting context, including a range citation for findings from direct research of the local Git checkout. The method resolves to `{ releases: [{ id, changes }] }`, with every requested release ID exactly once, one of the eight supported categories, and citations from that release's own `evidence`. Give an adapter a stable `cacheKey` to enable reusable draft caching, and change that key when its behavior changes. All adapter results receive the same output validation.

#### API Examples

```ts
import { generateChangelog, writeChangelog } from '@kitschpatrol/chagent'

const plan = await generateChangelog({ cwd: '/path/to/repository' })

// Inspect plan.files or edit their `after` contents before applying them.
await writeChangelog(plan)
```

### Bumpp integration

Chagent works nicely with the [bumpp](https://github.com/antfu-collective/bumpp) versioning and release tool.

#### Bumpp CLI approach

Execute chagent a part of the bump process:

```sh
bumpp --all --commit "Release {version}." --execute "chagent -i"
```

This runs the following sequence:

1. Bumpp updates the package version.
2. Chagent moves all existing `Unreleased` notes into the new release section, preserves their text, and adds missing changes. Older release sections remain unchanged.
3. The `-i` flag displays the diff and lets you edit, accept, or cancel. Saved edits are included when you accept.
4. Bumpp commits the version and changelog changes together, tags the release, and pushes.

Remove `-i` to skip review. Add `--no-push` if you want to push separately.

`--all` is needed for this command because bumpp otherwise commits only its version-update files. It includes every pending change, including unrelated and untracked files, so start from a clean working tree. It controls which files are committed, not which files bumpp updates versions in.

#### Bumpp configuration file approach

Alternatively, use the library callback in `bump.config.ts` to include only the generated changelogs alongside the version-update files, without `--all`:

```ts
import { createBumppHook } from '@kitschpatrol/chagent/bumpp'
import { defineConfig } from 'bumpp'

export default defineConfig({
  commit: 'Release {version}.',
  execute: createBumppHook(),
})
```

For review during releases, use `createBumppHook({ interactive: true })`. Other options include `agent`, `model`, `effort`, `github`, `cache`, and `editor`.

Bumpp updates versions before invoking the callback. The callback generates and reviews changelogs, stages only those files, and adds them to bumpp's explicit commit file list. Bumpp then commits and tags the complete release. Its existing push and publishing settings remain under your control.

Avoid putting changelogs in bumpp's version-replacement `files` option: it can replace version references in historical entries.

With either approach, a generation error or cancelled review stops bumpp before its commit and tag. Bumpp's already updated version files remain available for correction or retry. The callback requires bumpp 12.3.0 or newer and works with recursive releases.

For an existing post-bump workflow, `chagent --amend` explicitly amends an unpublished version-only release commit and updates matching local tags. It checks current remote refs, preserves unrelated staged work and tag annotations, and refuses published releases, ambiguous commits, detached HEAD, and signed tags. Signed tags need manual re-signing; the pre-commit callback avoids that problem. Chagent itself never pushes or publishes.

### Monorepos

Workspace declarations in `pnpm-workspace.yaml` or `package.json` determine the packages to process. Each current workspace package gets its own changelog. The root contains repository highlights and links to package releases.

For other monorepo layouts, configure `packages` directory globs. These directories do not need npm manifests; their Git tags identify releases, using the directory basename as the package name.

Shared-version repositories use repository versions at the root. Independently versioned repositories use package-qualified headings such as `@example/package@1.2.0`. Repository infrastructure changes appear in the root's `Unreleased` section. Explicit workspace dependencies contribute relevant source context to dependent packages. Dependency and tooling maintenance belongs under `Maintenance`; generated build output is excluded.

GitHub links to package changelogs on the default branch remain usable when a root entry is extracted for GitHub release notes.

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

Also supported: `chagent.config.mjs`, `chagent.config.js`, `chagent.config.json`, or a `chagent` key in `package.json`. CLI flags override configured values. `--config` selects a specific file.

Use `packages` and `exclude` directory globs to customize workspace discovery. Use `tagPatterns` to select unusual release tag conventions. Templates support `{name}` and `{version}`; defaults recognize `v1.2.3`, `1.2.3`, `@scope/package@1.2.3`, and `@scope/package/v1.2.3`.

## Background

### Implementation notes

Chagent reads reachable version tags and commit history regardless of the project's language. Optional npm metadata supplies workspace discovery, local version-bump detection before tagging, and the conditional Node.js compatibility note. Repository tags remain authoritative even when a root `package.json` has an unrelated tooling version. Other projects use tagged releases, or an explicit `release` context through the library API. Without reliable released-version boundaries, new changes belong to `Unreleased`; version numbers are not invented. An existing release heading with no matching Git boundary requires its tags or a corrected tag pattern. Shallow clones must be completed before generation.

GitHub enrichment uses release dates and commit-associated PR information. PR lookups batch unique commits across all requested releases and packages; each release receives only its associated PRs. **GitHub release-note bodies are never generation inputs.** Changelog files and generated build output are excluded from source evidence. Existing changelog prose is supplied only to preserve edits and avoid duplicate entries.

The agent chooses which historical source files, public interfaces, documentation, and build configuration to inspect. It reads Git snapshots at the supplied release refs instead of treating current or uncommitted files as historical evidence. `maxInputChars` bounds the starting context supplied to research adapters; it does not restrict which repository files they can investigate. Shared history requests prioritize release boundaries and existing human entries, then fit optional starting evidence into the remaining budget. An individual release's existing entries are never truncated. `timeoutMs` applies to each agent session. Lockfile maintenance retains its commit intent, while pure npm version-bump bookkeeping is excluded.

Agents return structured changes with evidence references. Application code owns the header, release boundaries, Markdown insertion, and Git writes. Agents run in the repository: Codex uses a read-only sandbox with approval requests disabled; Claude exposes read/search and Bash tools in [`dontAsk` mode](https://code.claude.com/docs/en/permissions), which allows read-only commands and denies actions requiring permission. Customizations are disabled for these invocations. Only chagent writes the reviewed changelog. Repository content is sent to the selected agent service using your existing account.

Drafts and checkpoints are stored under the checkout's Git directory in `chagent/`. They are disposable and are not committed. Shared session results are validated together and cached separately for each release. Completed sessions can be reused after interruptions; an interrupted session must run again. `--no-cache` disables reuse and persistence. Dry runs can populate the draft cache but do not apply changelog edits.

## Maintainers

[kitschpatrol](https://github.com/kitschpatrol)

## Acknowledgments

The bundled instructions adapt Rebecca Rae Barton's [release-notes skill](https://skillmd.com/skills/thatrebeccarae/release-notes). See [third-party notices](docs/third-party-notices.md) for provenance and licensing.

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
