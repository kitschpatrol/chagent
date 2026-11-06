# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-05

### Changed

- Exclude recognized JavaScript, Python, Rust, Go, Ruby, PHP, and Deno lockfiles from release evidence, and omit resolution-only dependency changes from generated entries even when committed alongside source changes.
- Allow otherwise eligible release commits containing Python, Rust, Go, Ruby, PHP, or Deno lockfile updates to pass `--amend` and `amendRelease()` validation.

### Documentation

- Clarify that dependency entries reflect declared version ranges and exclude lockfile-only resolution changes.

### Maintenance

- Expand regression coverage for lockfile-only ranges in pnpm, Python, Rust, and Go repositories and for commits mixing source and lockfile changes.

## [0.2.0] - 2026-11-05

### Changed

- **Breaking:** Change `--timeout` from seconds to minutes and replace the configuration and `generateChangelog()` option `timeoutMs` with `timeout`, measured in minutes with a default of 20.

### Fixed

- Fix quoting of editor commands and candidate file paths during interactive review on Windows.
- Avoid re-researching package releases already recorded in the root changelog when updating a shared-version workspace.

### Documentation

- Add a README warning that the project is under development and unsuitable for general use before version 1.0.
- Update CLI help, the README options table, and configuration examples for minute-based timeout settings.

### Maintenance

- Exclude `changelog.md` from ESLint and CSpell checks to resolve lint failures.
- Build before invoking the changelog CLI in the release script so release preparation uses the current implementation.

## [0.1.0] - 2026-11-05

### Added

- Initialize and update changelogs for Git projects of any language, reconstructing tagged release history and tracking new changes under `Unreleased`.
- Recognize pending npm version bumps and promote reviewed draft notes into releases while preserving historical Markdown and avoiding duplicate entries.
- Render Keep a Changelog Markdown with eight categories, breaking-change markers, comparison links, and conditional Node.js support notices.
- Support level-one and level-two release headings with links, dates, and `v` prefixes; reject duplicate or ambiguous headings and unclosed code fences.
- Generate entries through installed, authenticated Codex or Claude Code CLIs, with configurable models, reasoning effort, timeouts, and cancellation.
- Research multiple releases and packages together in shared agent sessions, splitting large histories according to the input budget.
- Generate package changelogs and linked root highlights for shared or independent workspace versions, including configured non-npm packages and historical workspace dependency context.
- Enrich release dates and commit-associated pull requests through optional `gh` integration, with batched lookups and fallback to local Git.
- Provide dry-run diffs, interactive review with editable temporary candidates, and `--rebuild` to reconstruct existing history; retain saved edits when review validation fails.
- Load optional TypeScript, JavaScript, ESM, JSON, or `package.json` configuration, with explicit CLI overrides and configurable package globs, exclusions, and tag patterns.
- Provide a typed ESM library exposing generation plans, preview, review, writing, configuration helpers, and custom `AgentAdapter` providers, requiring Node.js `^24.16.0 || >=26.3.0`.
- Validate adapter release IDs, categories, descriptions, and evidence citations, normalize entry formatting, and request one correction before rejecting invalid output.
- Apply changelog edits with HEAD and content checks, destination validation, write locking, and rollback while preserving the Git index.
- Persist reusable drafts and incremental checkpoints under the checkout’s Git directory, reuse completed sessions after interruptions, and support disabling caching with `--no-cache`.
- Integrate with bumpp 12.3.0+ through `createBumppHook`, optionally reviewing changes and including generated changelogs alongside version-update files.
- Offer `--amend` and `amendRelease` for verified unpublished version-only release commits, preserving unrelated staged work and tag annotations while refusing published releases and signed tags.
- Show session status and elapsed time, expose library `onProgress` and `setLogger` hooks, and provide `--verbose` logging for commands, cache decisions, and timing.
- Exclude changelogs, package-root generated output, and version-only release bookkeeping from source evidence while retaining lockfile-only maintenance commits.
- Isolate built-in agent research with restricted permissions, disabled user customizations, and ephemeral sessions.
- Recognize standard-version’s level-three version headings and identify unrecognized release headings in errors.
- Format written changelogs with the repository’s local `@kitschpatrol/shared-config` or `@kitschpatrol/prettier-config`, retaining incremental checkpoints across automatic or whitespace-only reformatting.
- Use local calendar dates for pending releases, bumpp’s `{date}` token, and dates obtained from GitHub releases.
- Link pending releases using the previous tag’s naming convention, the first configured tag pattern, or `v{version}` as a fallback.
- Preserve existing changelogs when `--rebuild` finds no release sections to record.
- Accept empty, comment-only, and settings-only `pnpm-workspace.yaml` files, with descriptive errors naming invalid workspace files.
- Apply explicit release contexts only to the package containing `cwd`, supporting independently versioned packages released from their own directories.
- Omit packages without notable changes from shared-version root summaries.
- Validate Node.js support and timeout limits, and check interactive-review and amendment prerequisites before starting agent research.
- Report CLI diagnostics on every exit path, with concise failure messages, actionable command and working-directory errors, and plain default logs.
- Show bumpp-hook progress and diagnostics on stderr, with custom status reporting through `onProgress`.
- Stop detached agents when an unhandled termination signal ends a library or bumpp host, and cancel CLI sessions on `SIGHUP`.

### Documentation

- Document local, global, and `npx` installation, agent authentication, CLI help, and library, configuration, monorepo, and rebuild examples.
- Explain bumpp CLI and hook workflows, interactive editor requirements, and supported post-bump amendment with publication and signing constraints.
- Explain supported release headings, generated-output exclusions, historical manifest handling, and agent context limits.
- Document Homebrew installation with `brew install kitschpatrol/tap/chagent`.
- Explain plain-object configuration for `npx`, Homebrew, and global installations without a local chagent dependency.
- Explain that automatic formatting runs after preview and review, can reformat historical sections, and preserves written changelogs if formatting fails.

### Maintenance

- Establish TypeScript builds, shared linting, cross-platform CI, release automation, and integration and property tests.
- Centralize option resolution and validation, and separate generation orchestration from package and workspace planning.
- Batch local Git commit, tag, and historical manifest reads to reduce subprocess overhead.

[0.1.0]: https://github.com/kitschpatrol/chagent/releases/tag/v0.1.0
[0.2.0]: https://github.com/kitschpatrol/chagent/compare/v0.1.0...v0.2.0
[0.3.0]: https://github.com/kitschpatrol/chagent/compare/v0.2.0...v0.3.0
