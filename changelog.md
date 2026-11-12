# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- Follow Git ancestry when ordering releases and choosing comparison boundaries, so fork releases can follow an upstream version with higher SemVer precedence.
- Recognize pending fork version bumps and backfill missing reachable releases in package changelogs and workspace summaries without rewriting recorded entries.

## [0.5.0] - 2026-11-06

### Added

- Recognize short version tags and headings such as `v1` and `1.2`, normalize missing components to zero, and ignore floating short tags that follow more precise releases.
- Extend `--amend` to recognize `npm version` commits and configured tag patterns, with an exported `AmendOptions` type for `amendRelease(plan, options)`.
- Match new entries to the newest released section containing entries, exposing its writing conventions to custom adapters through `ReleaseRequest.styleReference`.

### Changed

- Write concise agent-generated repository highlights instead of copying package entries into root summaries, followed by maintained `Packages` links that advance from drafts to released sections.
- Validate citations against each release's Git range, accept independently researched commits and abbreviated hashes, and retain valid sources when other citations fail.
- **Breaking:** Revise untouched generated drafts to consolidate later changes while preserving edited drafts; custom adapters must handle the new `revise` request mode and `draft` evidence.

### Fixed

- Research changes in package-root `build`, `coverage`, `dist`, and `changelog` directories when they contain source, including releases whose only changes occur there.

### Documentation

- Document short version boundaries and configuration options for amending `npm version` releases.
- Explain root summaries, style references, citation validation, source-directory research, and generated-draft ownership in the usage and adapter guides.

## [0.4.0] - 2026-11-05

### Added

- Add `rootChangelog`, `--root-changelog`, and the exported `RootChangelog` type to select repository summaries, a full root-package changelog, or no root changelog.
- Add `skipPackage` globs and repeatable `--skip-package` flags to omit workspace changelogs and root-summary entries while retaining relevant dependency context; reject unmatched patterns.

### Fixed

- Match package releases to shared root releases by commit as well as version, preventing unrelated releases with identical version numbers from appearing together.

### Documentation

- Explain root changelog modes, rebuilding after mode changes, and skipping packages while preserving dependency context.

### Maintenance

- Apply a shared 15-second test timeout to accommodate slow Git process spawning on Windows.

## [0.3.0] - 2026-11-05

### Changed

- Exclude lockfile-only commits and resolution changes from changelog evidence across JavaScript, Python, Rust, Go, Ruby, PHP, and Deno, while retaining declared dependency changes and `npm-shrinkwrap.json`.

### Documentation

- Clarify that dependency entries describe declared requirements and omit lockfile-only resolution updates.

## [0.2.0] - 2026-11-05

### Changed

- **Breaking:** Replace `timeoutMs` with minute-based `timeout` in configuration and generation options, and change CLI `--timeout` from seconds to minutes; retain the 20-minute default.

### Fixed

- Pass review editor commands verbatim to `cmd.exe` on Windows so command and file-path quoting works correctly.
- Avoid researching package releases already recorded in a shared-version root changelog when generating a new version.

### Documentation

- Add a pre-1.0 development warning and update timeout help and examples to use minutes.

### Maintenance

- Exclude generated changelogs from ESLint and CSpell checks.
- Build before release-time changelog generation so the release script uses the current implementation.

## [0.1.0] - 2026-11-05

### Added

- Generate complete release histories and incremental `Unreleased` notes from Git tags for projects in any language, extending Keep a Changelog with `Documentation` and `Maintenance` categories.
- Research historical snapshots through installed, authenticated Codex or Claude Code CLIs, sharing sessions across releases and validating structured responses with one correction attempt.
- Preserve historical Markdown and handwritten drafts during generation, recognize linked or dated version headings at levels one through three, and promote `Unreleased` notes into releases.
- Add a changelog header note when stable minor or patch releases raise their minimum Node.js requirement, including pending releases.
- Generate package changelogs and linked root summaries for shared or independently versioned workspaces, using npm/pnpm declarations or configured directory globs and historical workspace dependencies.
- Provide dry-run diffs, interactive editor review, and complete history reconstruction through `--dry-run`, `--interactive`, `--editor`, and `--rebuild`.
- Show elapsed CLI progress and concise diagnostics, with `--verbose` for command and session details and cancellation that stops running agents.
- Export `generateChangelog`, `previewChangelog`, `reviewChangelog`, and `writeChangelog` with typed plans, custom `AgentAdapter` support, progress/logging hooks, and guarded writes that detect concurrent edits and roll back failures.
- Load typed repository configuration from TypeScript, JavaScript, JSON, or `package.json`, with `defineConfig`/`loadConfig` helpers and explicit CLI overrides for agent settings, caching, workspace discovery, and tag patterns.
- Enrich evidence with commit-associated PRs and release dates through `gh`, format release dates in local time, and fall back to local Git when GitHub is unavailable.
- Store disposable drafts and checkpoints under Git metadata to reuse completed sessions and research only newer commits, with `--no-cache` to disable reuse and persistence.
- Format written changelogs with the repository's own `@kitschpatrol/shared-config` or `@kitschpatrol/prettier-config`, retaining written content and reporting diagnostics if formatting fails.
- Provide `createBumppHook` through `@kitschpatrol/chagent/bumpp` to generate and optionally review changelogs before releases, including only those files alongside bumpp's version updates.
- Support explicit post-bump amendment through `--amend` and `amendRelease`, preserving unrelated staged work and tag annotations while refusing published releases, signed tags, and ambiguous commits.
- Ship an ESM TypeScript library and `chagent` executable with npm/npx and Homebrew installation, requiring Node.js `^24.16.0 || >=26.3.0`.

### Documentation

- Document installation, CLI and TypeScript examples, configuration, monorepos, bumpp and amendment workflows, agent requirements, and caching behavior.

### Maintenance

- Set up TypeScript builds, shared linting and formatting, integration and property tests, cross-platform CI, and npm, Homebrew, and GitHub release tooling.

[0.1.0]: https://github.com/kitschpatrol/chagent/releases/tag/v0.1.0
[0.2.0]: https://github.com/kitschpatrol/chagent/compare/v0.1.0...v0.2.0
[0.3.0]: https://github.com/kitschpatrol/chagent/compare/v0.2.0...v0.3.0
[0.4.0]: https://github.com/kitschpatrol/chagent/compare/v0.3.0...v0.4.0
[0.5.0]: https://github.com/kitschpatrol/chagent/compare/v0.4.0...v0.5.0
