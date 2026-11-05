import { describe, expect, it } from 'vitest'
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

	it('excludes generated output only at the top of a package', async () => {
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

	it.each(['dist/out.js', 'coverage/report.txt', 'docs/CHANGELOG.md'])(
		'ignores a commit that only touches %s',
		async (file) => {
			const root = await createRepository()
			await git(root, ['tag', 'v1.0.0'])
			await writeFiles(root, { [file]: 'Generated.\n' })
			await commit(root, 'Regenerate output.')
			const repository = await inspectRepository(root)
			const releases = await resolveReleases(repository, repository.rootPackage, {})
			expect(await collectEvidence(repository, repository.rootPackage, releases.at(-1)!)).toEqual(
				[],
			)
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

	it('uses root release tags even when package.json belongs to unrelated tooling', async () => {
		const root = await createRepository({
			'package.json': '{"name":"docs-tooling","version":"0.0.0"}',
		})
		await git(root, ['tag', 'v2.0.0'])
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		expect(releases.map((release) => release.version)).toEqual(['2.0.0'])
	})

	it('includes lockfile-only maintenance without supplying the generated lockfile body', async () => {
		const root = await createRepository({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, {
			'pnpm-lock.yaml': 'lockfileVersion: 9\n# generated-lockfile-sentinel\n',
		})
		await commit(root, 'Refresh resolved dependencies.')
		const repository = await inspectRepository(root)
		const releases = await resolveReleases(repository, repository.rootPackage, {})
		const evidence = await collectEvidence(repository, repository.rootPackage, releases.at(-1)!)
		expect(evidence.find((item) => item.kind === 'commit')?.text).toContain(
			'Refresh resolved dependencies.',
		)
		expect(evidence.some((item) => item.text.includes('generated-lockfile-sentinel'))).toBe(false)
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
