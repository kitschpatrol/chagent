# How generation works

## Release boundaries

Chagent follows tags reachable from `HEAD` and orders releases by Git ancestry. Tags on the same commit are ordered by SemVer. A fork release such as `1.2.0-fork.2` can therefore follow `1.2.0`. Chagent fills gaps even when a missing release has a lower version than one already in the changelog.

Repository tags take precedence over an unrelated tooling version in a root `package.json`. Chagent can also detect a local npm version bump or accept an explicit release from the library. Changes without a release boundary go under `Unreleased`.

Existing release headings can use one or two hash marks, links, dates, short versions, or a `v` prefix. Level-three version headings are also recognized, as used for patch releases in standard-version. If chagent cannot match an existing version to Git history, fetch the missing tags or configure [tag patterns](config.md#release-tags). An unrecognized release heading or an unclosed code fence can also prevent an update.

## What the agent reads

Each run uses one agent. It can research several releases or packages in a session. Chagent splits large histories into batches and keeps each release's existing entries together. The agent reads Git snapshots at the supplied refs to see what changed at the time of the release.

The initial evidence can include commits, changes to declared dependency ranges, and associated GitHub pull requests. Chagent filters out lockfiles and likely generated directories, such as a package's top-level `dist`, from the starting evidence. The agent can inspect those directories when they contain source. Existing entries help it preserve edits and avoid duplicates, and the newest release section provides a writing sample. GitHub release-note bodies are excluded.

Codex runs in a read-only sandbox. Claude Code runs with read, search, and Bash tools in `dontAsk` mode. The agent returns proposed changes. Chagent validates the response and checks that each change cites an evidence ID or a commit in the release range. If validation fails, the agent gets one chance to correct the response before generation stops.

## Categories

Chagent uses the six standard Keep a Changelog categories (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`) for changes that affect users, including public APIs and runtime compatibility. Two additional categories cover other work.

- `Documentation` covers guides, examples, API docs, and help text.
- `Maintenance` covers internal refactoring, builds, tests, CI, release tooling, and routine dependency updates.

Classify dependency changes by their effect. An upgrade that fixes a user-visible bug belongs under `Fixed`. A routine refresh belongs under `Maintenance`.

## Drafts and checkpoints

Chagent stores drafts and checkpoints in `chagent/` inside the checkout's Git directory. A checkpoint records the last covered commit and whether chagent wrote the entire `Unreleased` draft. When the checkpoint still matches the file and release range, the next run can start from that commit. A later fix can then be folded into the generated entry it affects. Editing a draft during review or afterward preserves your wording on subsequent updates.

Completed sessions cache their results per release, so an interrupted run can reuse completed work. A dry run can populate the draft cache. Use `--no-cache` to disable draft and checkpoint reuse and storage.

## Formatting

Review and dry-run diffs show the proposed Markdown before formatting. After writing, chagent formats each changed changelog with the repository's own `@kitschpatrol/shared-config`, falling back to `@kitschpatrol/prettier-config` when available. This can reformat older sections too. If neither formatter is installed, the proposed Markdown is the final text. Formatting failures are reported in the plan diagnostics.
