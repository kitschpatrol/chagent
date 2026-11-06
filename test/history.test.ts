import { describe, expect, it, vi } from 'vitest'
import { collectEvidence } from '../src/lib/evidence'
import { git, readBlobs } from '../src/lib/process'
import { hasNodeException, inspectRepository, resolveReleases } from '../src/lib/repository'
import { commit, createRepository, writeFiles } from './helpers'

describe('release history', () => {
	it('includes the initial release and uses the predecessor of a tag at HEAD', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, {
			'index.js': 'export const answer = 43\n',
			'package.json': '{"name":"example","version":"1.1.0","engines":{"node":">=20"}}',
		})
		await commit(root, 'Change the answer.')
		await git(root, ['tag', 'v1.1.0'])
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		expect(releases.map((release) => release.version)).toEqual(['1.0.0', '1.1.0'])
		expect(releases[1]?.previousRef).toBe(releases[0]?.ref)
		const first = await collectEvidence(repository, repository.rootPackage, releases[0]!)
		const second = await collectEvidence(repository, repository.rootPackage, releases[1]!)
		expect(first[0]?.kind).toBe('range')
		expect(first.some((item) => item.text.includes('Add initial implementation.'))).toBe(true)
		expect(second.some((item) => item.text.includes('Change the answer.'))).toBe(true)
		expect(second.some((item) => item.text.includes('Add initial implementation.'))).toBe(false)
		expect(await hasNodeException(repository, repository.rootPackage, releases)).toBe(true)
	})

	it('recognizes an uncommitted version bump and otherwise uses Unreleased', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Fix the answer.')
		let repository = await inspectRepository(root)
		const unreleased = await resolveReleases(repository, repository.rootPackage, {})
		expect(unreleased.at(-1)?.version).toBe('Unreleased')
		await writeFiles(root, { 'package.json': '{"name":"example","version":"1.0.1"}' })
		repository = await inspectRepository(root)
		const bumped = await resolveReleases(repository, repository.rootPackage, {})
		expect(bumped.at(-1)).toMatchObject({
			pending: true,
			version: '1.0.1',
		})
		await commit(root, 'Release: 1.0.1')
		repository = await inspectRepository(root)
		const committed = await resolveReleases(repository, repository.rootPackage, {})
		expect(committed.at(-1)).toMatchObject({ pending: true, version: '1.0.1' })
	})

	it('notes a Node upgrade in the pending minor release that makes it', async () => {
		const root = await createRepository({
			'package.json': '{"name":"example","version":"1.0.0","engines":{"node":">=20"}}',
		})
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, {
			'package.json': '{"name":"example","version":"1.1.0","engines":{"node":">=24"}}',
		})
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		expect(releases.at(-1)).toMatchObject({ pending: true, version: '1.1.0' })
		expect(await hasNodeException(repository, repository.rootPackage, releases)).toBe(true)
	})

	it('does not treat Node upgrades in major releases as exceptions', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, {
			'package.json': '{"name":"example","version":"2.0.0","engines":{"node":">=20"}}',
		})
		await commit(root, 'Require Node 20.')
		await git(root, ['tag', 'v2.0.0'])
		const repository = await inspectRepository(root)
		expect(
			await hasNodeException(
				repository,
				repository.rootPackage,
				await resolveReleases(repository, repository.rootPackage, {}),
			),
		).toBe(false)
	})

	it('excludes generated changelog commits from source evidence', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'CHANGELOG.md': '# Changelog\n\nInvented release descriptions.\n' })
		await commit(root, 'Generate release notes.')
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		const release = releases.at(-1)!
		expect(await collectEvidence(repository, repository.rootPackage, release)).toEqual([])
	})

	it('leaves likely generated output out of supplied commits only at the top of a package', async () => {
		const root = await createRepository({
			'packages/build/dist/out.js': 'export const generated = 1\n',
			'packages/build/package.json': '{"name":"@example/build","version":"1.0.0"}',
			'packages/build/src/dist/source.js': 'export const source = 1\n',
			'packages/changelog/package.json': '{"name":"@example/changelog","version":"1.0.0"}',
			'packages/changelog/src/index.js': 'export const source = 1\n',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		const repository = await inspectRepository(root)
		const [build, changelog] = repository.packages
		const [buildRelease] = await resolveReleases(repository, build!, {})
		const [changelogRelease] = await resolveReleases(repository, changelog!, {})
		const buildEvidence = await collectEvidence(repository, build!, buildRelease!)
		const changelogEvidence = await collectEvidence(repository, changelog!, changelogRelease!)
		const buildText = buildEvidence.map((item) => item.text).join('\n')
		expect(buildText).toContain('packages/build/src/dist/source.js')
		expect(buildText).not.toContain('packages/build/dist/out.js')
		expect(changelogEvidence.map((item) => item.text).join('\n')).toContain(
			'packages/changelog/src/index.js',
		)
	})

	it.each([
		['dist/out.js', ['range']],
		['coverage/report.txt', ['range']],
		['build/core.py', ['range']],
		['docs/CHANGELOG.md', []],
		['node_modules/dependency/index.js', []],
	])(
		'leaves a commit that only touches %s for the agent to judge, unless it cannot be source',
		async (file, kinds) => {
			const root = await createRepository()
			await git(root, ['tag', 'v1.0.0'])
			await writeFiles(root, { [file]: 'Generated.\n' })
			await commit(root, 'Regenerate output.')
			const repository = await inspectRepository(root)
			const releases = await resolveReleases(repository, repository.rootPackage, {})
			const evidence = await collectEvidence(repository, repository.rootPackage, releases.at(-1)!)
			expect(evidence.map((item) => item.kind)).toEqual(kinds)
		},
	)

	it('reads tags that share a name with a branch', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await git(root, ['branch', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Move the branch away from the tag.')
		await git(root, ['branch', '--force', 'v1.0.0', 'HEAD'])
		const repository = await inspectRepository(root)
		expect(repository.tags.map((tag) => tag.name)).toEqual(['v1.0.0'])
		const tagged = await git(root, ['rev-parse', 'refs/tags/v1.0.0'])
		expect(repository.tags[0]?.commit).toBe(tagged)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		expect(releases.map((release) => release.version)).toEqual(['1.0.0', 'Unreleased'])
	})

	it('resolves lightweight, annotated, and nested tags to their commits', async () => {
		const root = await createRepository()
		const head = await git(root, ['rev-parse', 'HEAD'])
		await git(root, ['tag', 'light'])
		await git(root, ['tag', '-a', 'annotated', '-m', 'Annotated.'])
		await git(root, ['tag', '-a', 'nested', '-m', 'Nested.', 'annotated'])
		await git(root, ['tag', 'with,comma'])
		await git(root, ['checkout', '-q', '-b', 'side'])
		await writeFiles(root, { 'side.txt': 'Elsewhere.\n' })
		await commit(root, 'Add a side file.')
		await git(root, ['tag', 'unreachable'])
		await git(root, ['checkout', '-q', 'main'])
		const repository = await inspectRepository(root)
		expect(repository.tags.map((tag) => tag.name)).toEqual([
			'annotated',
			'light',
			'nested',
			'with,comma',
		])
		expect(new Set(repository.tags.map((tag) => tag.commit))).toEqual(new Set([head]))
		expect(repository.tags[0]?.date).toBe(await git(root, ['log', '-1', '--format=%cs']))
	})

	it('reports a merge once with the files from each parent and keeps its whole message', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await git(root, ['checkout', '-q', '-b', 'side'])
		await writeFiles(root, { 'side.txt': 'Side.\n' })
		await commit(root, 'Add the side file.')
		await git(root, ['checkout', '-q', 'main'])
		await writeFiles(root, { 'main.txt': 'Main.\n' })
		await commit(root, 'Add the main file.')
		await git(root, ['merge', '--no-ff', '-m', 'Merge the side.\n\nWith a body.', 'side'])
		const merge = await git(root, ['rev-parse', 'HEAD'])
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		const evidence = await collectEvidence(repository, repository.rootPackage, releases.at(-1)!)
		const merges = evidence.filter((item) => item.id === merge)
		expect(merges).toHaveLength(1)
		expect(merges[0]?.text).toContain('Merge the side.\n\nWith a body.\nFiles: ')
		expect(merges[0]?.text).toContain('side.txt')
		expect(merges[0]?.text).toContain('main.txt')
		expect(new Set(evidence.map((item) => item.id)).size).toBe(evidence.length)
	})

	it('lists a renamed file under both names', async () => {
		const root = await createRepository({ 'old-name.txt': 'Text.\n' })
		await git(root, ['tag', 'v1.0.0'])
		await git(root, ['mv', 'old-name.txt', 'new-name.txt'])
		await commit(root, 'Rename a file.')
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		const evidence = await collectEvidence(repository, repository.rootPackage, releases.at(-1)!)
		expect(evidence.at(-1)?.text).toContain('Files: new-name.txt, old-name.txt')
	})

	it('reads many objects, preserving UTF-8 and leaving out anything that is not a file', async () => {
		const root = await createRepository({ 'dir/file.txt': '☕ → ✓\n', 'other.txt': 'Plain.\n' })
		const blobs = await readBlobs(root, [
			'HEAD:dir/file.txt',
			'HEAD:dir',
			'HEAD:missing.txt',
			'HEAD:new\nline.txt',
			'HEAD:other.txt',
			'HEAD:other.txt',
		])
		expect(Object.fromEntries(blobs)).toEqual({
			'HEAD:dir/file.txt': '☕ → ✓\n',
			'HEAD:other.txt': 'Plain.\n',
		})
	})

	it('reads more objects than fit in one batch', async () => {
		const root = await createRepository({ 'file.txt': 'Text.\n' })
		const missing = Array.from({ length: 600 }, (_, index) => `HEAD:missing-${index}.txt`)
		const blobs = await readBlobs(root, [...missing, 'HEAD:file.txt'])
		expect(blobs.get('HEAD:file.txt')).toBe('Text.\n')
		expect(blobs.size).toBe(1)
	})

	it('retains documentation and maintenance evidence for historical research', async () => {
		const root = await createRepository({
			'index.js': 'export { publicMethod } from "./internal.js"\n',
			'internal.js': 'export const publicMethod = () => 1\nexport const helper = () => 2\n',
			'package.json':
				'{"name":"example","version":"1.0.0","exports":"./index.js","devDependencies":{"tool":"^1.0.0"}}',
			'readme.md': 'Install with the old command.\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, {
			'internal.js': 'export const publicMethod = () => 1\nconst helper = () => 2\n',
			'package.json':
				'{"name":"example","version":"1.0.0","exports":"./index.js","devDependencies":{"tool":"^1.0.1"}}',
			'readme.md': 'Install with the corrected command.\n',
		})
		await commit(
			root,
			'Update tooling to fix Node compatibility and correct installation guidance.',
		)
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		const evidence = await collectEvidence(repository, repository.rootPackage, releases.at(-1)!)
		const source = evidence.find((item) => item.kind === 'commit')?.text
		expect(source).toContain('fix Node compatibility')
		expect(source).toContain('Files: internal.js, package.json, readme.md')
		expect(evidence[0]?.kind).toBe('range')
		expect(evidence[0]?.text).toContain('git show')
	})

	it('reads two-part version tags as patch zero and links the tags as written', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Change the answer.')
		await git(root, ['tag', 'v1.1'])
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		expect(releases).toMatchObject([
			{ tag: 'v1.0', version: '1.0.0' },
			{ previousTag: 'v1.0', tag: 'v1.1', version: '1.1.0' },
		])
	})

	it('reads v-prefixed one-part version tags alongside more precise ones', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Change the answer.')
		await git(root, ['tag', 'v1.1'])
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Change the answer again.')
		await git(root, ['tag', 'v2'])
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		expect(releases).toMatchObject([
			{ tag: 'v1', version: '1.0.0' },
			{ previousTag: 'v1', tag: 'v1.1', version: '1.1.0' },
			{ previousTag: 'v1.1', tag: 'v2', version: '2.0.0' },
		])
	})

	it.each(['1', 'example@1', 'v1.x', 'v01', 'v01.0', 'v1.0.0.0'])(
		'ignores the tag %s',
		async (tag) => {
			const root = await createRepository()
			await git(root, ['tag', tag])
			const repository = await inspectRepository(root)
			const releases = await resolveReleases(repository, repository.rootPackage, {})
			expect(releases.map((release) => release.version)).toEqual(['Unreleased'])
		},
	)

	it('reads bare one-part version tags through configured tag patterns', async () => {
		const root = await createRepository()
		await git(root, ['tag', '1'])
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {
			tagPatterns: ['{version}'],
		})
		expect(releases).toMatchObject([{ tag: '1', version: '1.0.0' }])
	})

	it.each([
		['v1', 'v1.2.0', '1.2.0'],
		['v1', 'v1.0', '1.0.0'],
		['v1.2', 'v1.2.1', '1.2.1'],
	])('ignores %s on the same commit as the more precise %s', async (floating, precise, version) => {
		const root = await createRepository()
		await git(root, ['tag', precise])
		await git(root, ['tag', floating])
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		expect(releases).toMatchObject([{ tag: precise, version }])
	})

	it('reads a one-part tag that follows prereleases of its release', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0-beta.1'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Change the answer.')
		await git(root, ['tag', 'v1'])
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		expect(releases).toMatchObject([
			{ tag: 'v1.0.0-beta.1', version: '1.0.0-beta.1' },
			{ previousTag: 'v1.0.0-beta.1', tag: 'v1', version: '1.0.0' },
		])
	})

	it.each(['v1.2.0', 'v2.1.0'])(
		'reads a two-part tag from a merged maintenance branch despite %s on main',
		async (later) => {
			const root = await createRepository()
			await git(root, ['tag', 'v1.0.0'])
			await git(root, ['checkout', '-q', '-b', 'maintenance'])
			await writeFiles(root, { 'maintenance.txt': 'Backport.\n' })
			await commit(root, 'Backport a fix.')
			await git(root, ['tag', 'v1.1'])
			await git(root, ['checkout', '-q', 'main'])
			await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
			await commit(root, 'Change the answer.')
			await git(root, ['tag', later])
			await git(root, ['merge', '--no-ff', '-m', 'Merge maintenance.', 'maintenance'])
			const repository = await inspectRepository(root)
			const releases = await resolveReleases(repository, repository.rootPackage, {})
			expect(releases.map((release) => release.tag ?? release.version)).toEqual([
				'v1.0.0',
				'v1.1',
				later,
				'Unreleased',
			])
		},
	)

	it('prefers full version tags over two-part tags for the same release', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0'])
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Fix the answer.')
		await git(root, ['tag', 'v1.1.0'])
		await git(root, ['tag', '--force', 'v1.0'])
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		expect(releases).toMatchObject([
			{ tag: 'v1.0.0', version: '1.0.0' },
			{ previousTag: 'v1.0.0', tag: 'v1.1.0', version: '1.1.0' },
		])
	})

	it.each([
		['full', 'v1.0.0', '1.0.0'],
		['two-part', 'v1.0', '1.0'],
	])('rejects %s version tags that disagree about a release', async (_label, first, second) => {
		const root = await createRepository()
		await git(root, ['tag', first])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Fix the answer.')
		await git(root, ['tag', second])
		const repository = await inspectRepository(root)
		await expect(resolveReleases(repository, repository.rootPackage, {})).rejects.toThrow(
			'Multiple reachable tags disagree about example 1.0.0.',
		)
	})

	it('uses root release tags even when package.json belongs to unrelated tooling', async () => {
		const root = await createRepository({
			'package.json': '{"name":"docs-tooling","version":"0.0.0"}',
		})
		await git(root, ['tag', 'v2.0.0'])
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		expect(releases.map((release) => release.version)).toEqual(['2.0.0'])
	})

	it.each([
		['pnpm-lock.yaml', {}],
		['uv.lock', { 'pyproject.toml': '[project]\nname = "example"\nversion = "1.0.0"\n' }],
		['Cargo.lock', { 'Cargo.toml': '[package]\nname = "example"\nversion = "1.0.0"\n' }],
		['go.sum', { 'go.mod': 'module example.com/example\n' }],
	])('treats a range of %s-only changes as empty', async (lockfile, manifest) => {
		const root = await createRepository(
			{ ...manifest, [lockfile]: 'version = 1\n' },
			lockfile === 'pnpm-lock.yaml',
		)
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { [lockfile]: 'version = 1\n# refreshed\n' })
		await commit(root, 'Refresh resolved dependencies.')
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		expect(await collectEvidence(repository, repository.rootPackage, releases.at(-1)!)).toEqual([])
	})

	it('drops lockfile-only commits and omits lockfiles from listed commit files', async () => {
		const root = await createRepository({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'pnpm-lock.yaml': 'lockfileVersion: 9\n# refreshed\n' })
		await commit(root, 'Refresh resolved dependencies.')
		await writeFiles(root, {
			'index.js': 'export const answer = 43\n',
			'pnpm-lock.yaml': 'lockfileVersion: 9\n# refreshed again\n',
		})
		await commit(root, 'Change the answer.')
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		const evidence = await collectEvidence(repository, repository.rootPackage, releases.at(-1)!)
		const commits = evidence.filter((item) => item.kind === 'commit')
		expect(commits).toHaveLength(1)
		expect(commits[0]?.text).toContain('Change the answer.')
		expect(commits[0]?.text).not.toContain('pnpm-lock.yaml')
	})

	it('keeps manifest and lockfile release bookkeeping out of an otherwise empty range', async () => {
		const root = await createRepository({ 'package-lock.json': '{"version":"1.0.0"}' })
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, {
			'package-lock.json': '{"version":"1.0.1"}',
			'package.json': '{"name":"example","version":"1.0.1","engines":{"node":">=18"}}',
		})
		await commit(root, 'Release: 1.0.1')
		await git(root, ['tag', 'v1.0.1'])
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		expect(await collectEvidence(repository, repository.rootPackage, releases[1]!)).toEqual([])
	})

	it.each([
		['an empty', ''],
		['a comment-only', '# Settings come later.\n'],
		['a settings-only', 'onlyBuiltDependencies:\n  - esbuild\n'],
	])('reads %s pnpm-workspace.yaml as declaring no packages', async (_label, text) => {
		const root = await createRepository({ 'pnpm-workspace.yaml': text })
		const repository = await inspectRepository(root)
		expect(repository.packages).toEqual([])
	})

	it.each([
		['packages: 5\n', 'Invalid pnpm-workspace.yaml'],
		['packages: [\n', 'Cannot parse pnpm-workspace.yaml'],
	])('names pnpm-workspace.yaml when it is unusable: %j', async (text, message) => {
		const root = await createRepository({ 'pnpm-workspace.yaml': text })
		await expect(inspectRepository(root)).rejects.toThrow(message)
	})

	it('discovers pnpm packages and their independent tags', async () => {
		const root = await createRepository({
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'packages/b/package.json': '{"name":"@example/b","version":"2.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await git(root, ['tag', '@example/a@1.0.0'])
		await git(root, ['tag', '@example/b@2.0.0'])
		const repository = await inspectRepository(root)
		expect(repository.packages.map((pkg) => pkg.name)).toEqual(['@example/a', '@example/b'])
		const releases = await resolveReleases(repository, repository.packages[1]!, {})
		expect(releases.map((release) => release.version)).toEqual(['2.0.0'])
	})

	it.each([
		['the previous tag format', ['v1.0.0'], undefined, 'v1.1.0'],
		['an unprefixed previous tag', ['1.0.0'], undefined, '1.1.0'],
		['a package-qualified previous tag', ['example@1.0.0'], undefined, 'example@1.1.0'],
		['v{version} without a previous tag', [], undefined, 'v1.1.0'],
		['the first configured pattern', [], ['{name}-{version}'], 'example-1.1.0'],
	])('predicts a pending release tag from %s', async (_label, tags, tagPatterns, tag) => {
		const root = await createRepository()
		for (const name of tags) {
			await git(root, ['tag', name])
		}

		await writeFiles(root, { 'package.json': '{"name":"example","version":"1.1.0"}' })
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, { tagPatterns })
		expect(releases.at(-1)).toMatchObject({ pending: true, tag, version: '1.1.0' })
	})

	it.each([
		['Pacific/Kiritimati', '2026-11-06'],
		['America/New_York', '2026-11-05'],
	])('dates a pending release in local time (%s)', async (zone, date) => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'package.json': '{"name":"example","version":"1.1.0"}' })
		const repository = await inspectRepository(root)
		vi.stubEnv('TZ', zone)
		vi.useFakeTimers({ now: new Date('2026-11-06T02:00:00Z'), toFake: ['Date'] })
		try {
			const releases = await resolveReleases(repository, repository.rootPackage, {})
			expect(releases.at(-1)).toMatchObject({ date, pending: true })
		} finally {
			vi.useRealTimers()
			vi.unstubAllEnvs()
		}
	})

	it('excludes version-only release commits from PR enrichment evidence', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 45\n' })
		await commit(root, 'Improve the answer.')
		const sourceCommit = await git(root, ['rev-parse', 'HEAD'])
		await writeFiles(root, {
			'changelog.md': '# Changelog\n\nDo not repeat generated descriptions.\n',
			'package.json': '{"name":"example","version":"1.0.1","engines":{"node":">=18"}}',
		})
		await commit(root, 'Release: 1.0.1')
		await git(root, ['tag', 'v1.0.1'])
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		const evidence = await collectEvidence(repository, repository.rootPackage, releases[1]!)
		expect(evidence.filter((item) => item.kind === 'commit').map((item) => item.id)).toEqual([
			sourceCommit,
		])
	})

	it('uses workspace dependency relationships from each historical release', async () => {
		const root = await createRepository({
			'packages/a/package.json':
				'{"name":"@example/a","version":"1.0.0","dependencies":{"@example/b":"workspace:*"}}',
			'packages/b/index.js': 'export const shared = 1\n',
			'packages/b/package.json': '{"name":"@example/b","version":"1.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, {
			'packages/a/package.json': '{"name":"@example/a","version":"2.0.0"}',
		})
		await commit(root, 'Remove the shared dependency.')
		const repository = await inspectRepository(root)
		const pkg = repository.packages[0]!
		const releases = await resolveReleases(repository, pkg, {})
		const evidence = await collectEvidence(repository, pkg, releases[0]!)
		expect(evidence.some((item) => item.text.includes('packages/b/index.js'))).toBe(true)
	})
})
