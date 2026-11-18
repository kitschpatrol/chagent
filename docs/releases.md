# Release workflows

## Include changelogs in a bumpp release

With bumpp 12.3.0 or newer, add the chagent hook to `bump.config.ts`.

```ts
import { createBumppHook } from '@kitschpatrol/chagent/bumpp'
import { defineConfig } from 'bumpp'

export default defineConfig({
  execute: createBumppHook({ interactive: true }),
})
```

Bumpp updates the version first. The hook moves the `Unreleased` notes into the new release, generates missing entries, and opens the diff for review. On acceptance, it stages the changed changelogs and adds them to bumpp's commit file list. Bumpp handles the commit, tag, and push according to its configuration.

Use `createBumppHook()` for a release without interactive review. The hook accepts generation options such as `agent` and `model`, an `editor` for review, and `onProgress` for status messages. It also supports recursive releases and releases run from an individual package directory. Keep changelogs out of bumpp's version-replacement `files` option, which can rewrite version numbers in older entries.

## Run chagent as a shell command

Start with a clean working tree. Bumpp's `--all` stages every pending change, including untracked files.

```sh
bumpp --all --execute "chagent -i"
```

The `--all` flag includes the changelog in the release commit. Remove `-i` to skip review or add `--no-push` to push later. With either integration, a generation failure or cancelled review stops bumpp before the commit and tag. The updated version files stay in the working tree.

## Add notes to an unpublished release

If a tool such as `npm version` has already committed the version bump, run `chagent --amend --interactive` before pushing. Chagent checks the commit at `HEAD` and the refs advertised by each remote. After review it amends the version-only release commit and moves its matching local tags, preserving tag annotations and unrelated staged work.

Amendment requires a checked-out branch and a recognizable, unpublished release commit. An unrelated or signed tag on the commit prevents amendment. Use the pre-commit hook when your workflow signs release tags.
