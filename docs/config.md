# Configuration and workspaces

Chagent looks in the repository root for `chagent.config.ts`, `chagent.config.mjs`, `chagent.config.js`, `chagent.config.json`, or a `chagent` key in `package.json`. To select a file explicitly, use `--config`. CLI flags take precedence over the file, and the file overrides the built-in defaults.

With chagent installed in the project, use `defineConfig` for TypeScript completion. A plain default export also works when you run chagent through Homebrew, npx, or a global installation.

```ts
import { defineConfig } from '@kitschpatrol/chagent'

export default defineConfig({
  rootChangelog: 'package',
  skipPackage: ['packages/examples'],
})
```

The [CLI option table](../readme.md#commands) lists the agent, model, effort, and timeout defaults. The timeout applies to each agent session. `maxInputChars` controls how much starting context chagent supplies per request (default 80,000 characters, minimum 4,000). The agent can inspect other files in the release's Git history.

## Workspace discovery

Chagent reads workspace directories from `pnpm-workspace.yaml` or `package.json`. Set `packages` to supply your own directory globs. Explicitly selected directories can use any build system. For a directory without an npm manifest, chagent uses its basename as the package name.

Use `skipPackage` or repeat `--skip-package` to skip changelog generation for selected workspace packages. Each glob must match a package directory. A skipped package stays outside the root's own changes, and changes to it can still matter to packages that depend on it. Use `exclude` to remove a directory from workspace discovery and count its changes with the root.

## Root changelog

| `rootChangelog`     | What appears at the root                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `summary` (default) | Release highlights and a `Packages` list linking to individual package entries.                               |
| `package`           | A full changelog for the root package, covering its files and relevant changes in its workspace dependencies. |
| `none`              | Only package changelogs are written. At least one workspace package must remain to document.                  |

In summary mode, packages released together appear under the repository version. Independently versioned packages get headings such as `@example/package@1.2.0`. Between releases the root summary can link to a package's `Unreleased` section. Chagent updates the link when the package is released.

If you change modes and want older sections in the new format, preview the replacement with `chagent --rebuild --dry-run`. A rebuild also regenerates the package changelogs.

## Release tags

The default patterns recognize `v1.2.3`, `1.2.3`, `@scope/package@1.2.3`, and `@scope/package/v1.2.3`. For another convention, set `tagPatterns` to an array such as `['release-{version}']`. Each pattern requires `{version}` and may include `{name}`.

A short tag such as `v1` or `v1.2` can mark the initial `1.0.0` or `1.2.0` release if it precedes all more precise tags in its series. This prevents floating tags from becoming extra releases. A single bare number such as `1` requires an explicit tag pattern.
