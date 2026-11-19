# chagent

<!-- badges -->

[![NPM Package @kitschpatrol/chagent](https://img.shields.io/npm/v/@kitschpatrol/chagent.svg)](https://www.npmjs.com/package/@kitschpatrol/chagent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/license/mit)
[![CI](https://github.com/kitschpatrol/chagent/actions/workflows/ci.yml/badge.svg)](https://github.com/kitschpatrol/chagent/actions/workflows/ci.yml)
[![Homebrew](https://img.shields.io/badge/Homebrew-kitschpatrol%2Ftap%2Fchagent-FBB040?logo=homebrew&logoColor=white)](https://github.com/kitschpatrol/homebrew-tap/blob/HEAD/Formula/chagent.rb)

<!-- /badges -->

<!-- short-description -->

**Changelog agent. CLI tool and TypeScript library to generate and update changelogs with a little help from your LLMs.**

<!-- /short-description -->

> [!WARNING]
>
> **This project is under development. It should not be considered suitable for general use until a 1.0 release.**

## Overview

Run `chagent` in a Git repository to draft a changelog from its tagged releases. If you already have a changelog, chagent fills in missing releases and adds changes since the last tag under `Unreleased`. Projects can use any language or build system.

The agent can revise its own `Unreleased` draft as work continues. Once you edit the draft, chagent keeps your wording and adds new entries alongside it. At release time, those notes move into the versioned section. See [this project's changelog](changelog.md) for an example.

In a perfect world, every changelog entry would be written with loving human care. However, as projects accumulate and life's finitude comes into focus, delegating a first draft to an LLM might be better than having no changelog at all in some contexts.

## Getting started

<!-- dependencies -->

### Dependencies

- [Node.js](https://nodejs.org/) 24.16.0 or newer (specifically `^24.16.0 || >=26.3.0`)

<!-- /dependencies -->

Use a full Git checkout with its release tags. Install and sign in to Codex CLI (the default) or Claude Code. Chagent uses that CLI and account to send repository context to the selected agent service. An authenticated `gh` CLI can also supply pull requests and release dates.

<!-- install -->

### Installation

There are several ways to install @kitschpatrol/chagent depending on how you're planning to use it:

#### CLI

Run it once without installing:

```sh
npx @kitschpatrol/chagent
```

Or install it globally with Homebrew:

```sh
brew install kitschpatrol/tap/chagent
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

<!-- cli-help -->

#### Commands

##### Command: `chagent`

Initialize or update changelogs from repository history.

Usage:

```txt
chagent
```

| Option                  | Description                                                                             | Type                                          | Default                            |
| ----------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------- |
| `--cwd`                 | Repository directory                                                                    | `string`                                      | current directory                  |
| `--agent`<br>`-a`       | Installed agent CLI                                                                     | `"codex"` `"claude"`                          | `codex`                            |
| `--model`<br>`-m`       | Agent model                                                                             | `string`                                      | gpt-6.2-sol (Codex); opus (Claude) |
| `--effort`<br>`-e`      | Reasoning effort                                                                        | `"low"` `"medium"` `"high"` `"xhigh"` `"max"` | `xhigh`                            |
| `--interactive`<br>`-i` | Review a diff and optionally edit before writing                                        | `boolean`                                     | `false`                            |
| `--editor`              | Editor command for interactive review; configure GUI editors to wait                    | `string`                                      | git var GIT_EDITOR                 |
| `--dry-run`             | Print a diff without applying changes                                                   | `boolean`                                     | `false`                            |
| `--rebuild`             | Reconstruct all history, replacing existing release text                                | `boolean`                                     | `false`                            |
| `--amend`               | Amend a verified unpublished release commit and matching local tags                     | `boolean`                                     | `false`                            |
| `--root-changelog`      | Monorepo root changelog: a summary of package releases, the root package alone, or none | `"summary"` `"package"` `"none"`              | `summary`                          |
| `--skip-package`        | Workspace package directory glob to leave without a changelog; repeatable               | `array`                                       | `none`                             |
| `--github`              | Enrich Git evidence using gh when available; disable with --no-github                   | `boolean`                                     | `true`                             |
| `--cache`               | Cache drafts and incremental state; disable with --no-cache                             | `boolean`                                     | `true`                             |
| `--config`              | Configuration file path                                                                 | `string`                                      | auto-detected from repository root |
| `--timeout`             | Agent timeout in minutes                                                                | `number`                                      | `20`                               |
| `--verbose`             | Log commands, cache decisions, and session details to stderr                            | `boolean`                                     | `false`                            |
| `--help`<br>`-h`        | Show help                                                                               | `boolean`                                     |                                    |
| `--version`<br>`-v`     | Show version number                                                                     | `boolean`                                     |                                    |

<!-- /cli-help -->

#### CLI Examples

Run chagent from the repository you want to document.

```sh
chagent --dry-run     # Print the proposed diff
chagent --interactive # Review, edit, and accept or cancel
chagent               # Write the changelog
chagent --agent claude --interactive
```

Interactive review uses your Git editor. For VS Code, use `--editor "code --wait"`. A plain run leaves the changes in your working tree for you to commit.

Use **`--rebuild`** only when you want to replace existing release text, including hand-written entries. Preview the replacement with `chagent --rebuild --dry-run`.

### Library API

`generateChangelog` prepares the edits. Call `writeChangelog` to apply them, or `previewChangelog` to get a unified diff.

```ts
import { generateChangelog, writeChangelog } from '@kitschpatrol/chagent'

const plan = await generateChangelog({ cwd: '/path/to/repository' })
await writeChangelog(plan)
```

The [library reference](docs/library.md) covers interactive review, progress reporting, and custom agent adapters.

### Configuration

To set defaults for a repository, put them in `chagent.config.ts` at the repository root. Explicit CLI flags override those defaults.

```ts
export default {
  agent: 'claude',
  github: false,
}
```

In a monorepo, chagent writes per-package changelogs and a root summary with links to the package releases. See [configuration and workspaces](docs/config.md) for other layouts, root changelog modes, and tag patterns.

### Bumpp integration

Use `createBumppHook()` in your bumpp configuration to include the changelogs in the release commit. The [release guide](docs/releases.md) includes a working configuration, a shell alternative, and the post-bump workflow for `npm version`.

## Background

Git tags tell chagent where each release begins and ends. The selected agent reads the commits and files in that range and proposes entries. Chagent checks their source references and writes the Markdown. See [how generation works](docs/generation.md) for release detection, categories, caching, and formatting.

Why default to `changelog.md` and not `CHANGELOG.md`? Because there's no need to yell.

## The future

Possible additions include CI integration and dropping the agent CLI dependency.

## Maintainers

[kitschpatrol](https://github.com/kitschpatrol)

## Acknowledgments

Chagent follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) for its release format.

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
