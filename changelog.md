# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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

### Documentation

- Document local, global, and `npx` installation, agent authentication, CLI help, and library, configuration, monorepo, and rebuild examples.
- Explain bumpp CLI and hook workflows, interactive editor requirements, and supported post-bump amendment with publication and signing constraints.
- Explain supported release headings, generated-output exclusions, historical manifest handling, and agent context limits.

### Maintenance

- Establish TypeScript builds, shared linting, cross-platform CI, release automation, and integration and property tests.
- Centralize option resolution and validation, and separate generation orchestration from package and workspace planning.
- Batch local Git commit, tag, and historical manifest reads to reduce subprocess overhead.
