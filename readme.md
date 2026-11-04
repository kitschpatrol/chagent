<!-- title -->

# @kitschpatrol/chagent

<!-- /title -->

<!-- badges -->

[![NPM Package @kitschpatrol/chagent](https://img.shields.io/npm/v/@kitschpatrol/chagent.svg)](https://www.npmjs.com/package/@kitschpatrol/chagent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/license/mit)
[![CI](https://github.com/kitschpatrol/chagent/actions/workflows/ci.yml/badge.svg)](https://github.com/kitschpatrol/chagent/actions/workflows/ci.yml)

<!-- /badges -->

<!-- short-description -->

**A cli+library project.**

<!-- /short-description -->

## Overview

## Getting started

<!-- dependencies -->

### Dependencies

- [Node.js](https://nodejs.org/) 24.16.0 or newer (specifically `^24.16.0 || >=26.3.0`)

<!-- /dependencies -->

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

### Agent skills

`pnpm install` links agent skills from `@kitschpatrol/shared-config` into
`.agents/skills` and `.claude/skills`, as configured by the `permissions` and
`skills` settings in `pnpm-workspace.yaml`. Both directories are ignored by Git.

## Usage

### Library

#### API

#### Examples

### CLI

<!-- cli-help({ heading: false, headingLevel: 3 }) -->

#### Command: `chagent`

Run a chagent command.

This section lists top-level commands for `chagent`.

If no command is provided, `chagent do-something` is run by default.

Usage:

```txt
chagent [command]
```

| Command             | Description                                        |
| ------------------- | -------------------------------------------------- |
| `do-something`      | Run the do-something command. _(Default command.)_ |
| `do-something-else` | Run the do-something-else command.                 |

_See the sections below for more information on each subcommand._

#### Subcommand: `chagent do-something`

Run the do-something command.

Usage:

```txt
chagent do-something
```

| Option              | Description              | Type      | Default |
| ------------------- | ------------------------ | --------- | ------- |
| `--verbose`         | Run with verbose logging | `boolean` | `false` |
| `--help`<br>`-h`    | Show help                | `boolean` |         |
| `--version`<br>`-v` | Show version number      | `boolean` |         |

#### Subcommand: `chagent do-something-else`

Run the do-something-else command.

Usage:

```txt
chagent do-something-else
```

| Option              | Description              | Type      | Default |
| ------------------- | ------------------------ | --------- | ------- |
| `--verbose`         | Run with verbose logging | `boolean` | `false` |
| `--help`<br>`-h`    | Show help                | `boolean` |         |
| `--version`<br>`-v` | Show version number      | `boolean` |         |

<!-- /cli-help -->

#### Examples

### Benchmarks

Run `pnpm bench` to measure the example in `test/index.bench.ts`. Run
`pnpm bench:baseline` to save or replace `test/benchmarks/baseline.json`;
subsequent `pnpm bench` runs compare against it without overwriting it.
Use a separate result file for each benchmark you add, and generate baselines
in a consistent environment. Vitest 4 benchmark JSON files must be regenerated
with Vitest 5.

## Background

### Motivation

### Implementation notes

### Similar projects

## The future

## Maintainers

_List maintainer(s) for a repository, along with one way of contacting them (e.g. GitHub link or email)._

## Acknowledgments

_State anyone or anything that significantly helped with the development of your project. State public contact hyper-links if applicable._

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
