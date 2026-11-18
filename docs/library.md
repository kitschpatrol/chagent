# Library reference

## Generate, review, and write

`generateChangelog(options)` returns a plan with proposed file edits, release summaries, and diagnostics. Each edit has a path, the original contents (`before`), and the proposed contents (`after`). You can inspect or edit `after` before writing.

```ts
import { generateChangelog, reviewChangelog, writeChangelog } from '@kitschpatrol/chagent'

const plan = await generateChangelog({ cwd: '/path/to/repository' })
const reviewed = await reviewChangelog(plan)
if (reviewed) {
  await writeChangelog(reviewed)
}
```

`reviewChangelog` requires a terminal. It opens temporary files in the Git editor or the supplied `{ editor }`, shows the diff again after edits, and returns `undefined` on cancellation. To get the diff as a string, call `await previewChangelog(plan)`.

`writeChangelog` checks that Git HEAD and the original changelog contents still match the plan. It rejects symlink destinations, rolls back partial writes on failure, and returns the paths it wrote. Check `plan.diagnostics` after writing for formatting or checkpoint warnings.

Library calls are quiet by default. Pass `onProgress` to `generateChangelog` for status messages, or use `setLogger` for logging. Use the `release` option when your release tool knows the upcoming version before it creates a tag.

For the [post-bump workflow](releases.md#add-notes-to-an-unpublished-release), call `amendRelease(plan, options)`. Pass the same `configFile`, `packages`, `exclude`, and `tagPatterns` overrides you supplied directly to generation.

## Custom agent adapters

Pass an `AgentAdapter` as the `agent` option. Its `generate(request)` method receives the repository root, run settings, and one or more releases to research. Each release identifies the package, directory scope, Git refs, and starting evidence.

Return `{ releases: [{ id, changes }] }` with each requested ID exactly once. A change has a single-line Markdown `description`, a supported `category`, a boolean `breaking` flag, and a `sources` array. Cite at least one supplied evidence ID for that release or a commit in its Git range. The supplied range ID can support a finding that spans several commits.

In `update` mode, return additions to the existing entries. In `revise` mode, the existing entries are a generated draft covering history through `repository.from`. Return the complete replacement and cite the `draft` evidence ID for entries carried forward.

Set a stable `cacheKey` to reuse generated drafts across runs. Change the key when the adapter's behavior changes. Chagent applies the same output and citation checks to built-in and custom adapters.
