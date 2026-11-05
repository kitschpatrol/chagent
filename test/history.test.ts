import { describe, expect, it } from 'vitest'
import { collectEvidence } from '../src/lib/evidence'
import { git } from '../src/lib/process'
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
		expect(first.some((item) => item.text.includes('answer = 42'))).toBe(true)
		expect(second.some((item) => item.text.includes('+export const answer = 43'))).toBe(true)
		expect(await hasNodeException(repository, repository.rootPackage, releases)).toBe(true)
	})

	it('recognizes an uncommitted version bump and otherwise uses Unreleased', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Fix the answer.')
		let repository = await inspectRepository(root)
		const awaitedResult1 = await resolveReleases(repository, repository.rootPackage, {})
		expect(awaitedResult1.at(-1)?.version).toBe('Unreleased')
		await writeFiles(root, { 'package.json': '{"name":"example","version":"1.0.1"}' })
		repository = await inspectRepository(root)
		const awaitedResult2 = await resolveReleases(repository, repository.rootPackage, {})
		expect(awaitedResult2.at(-1)).toMatchObject({
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
		const awaitedResult3 = await resolveReleases(repository, repository.rootPackage, {})
		const release = awaitedResult3.at(-1)!
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
		const buildIds = buildEvidence.map((item) => item.id)
		expect(buildIds).toContain('diff:packages/build/src/dist/source.js')
		expect(buildIds).not.toContain('diff:packages/build/dist/out.js')
		expect(changelogEvidence.map((item) => item.id)).toContain(
			'diff:packages/changelog/src/index.js',
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
		expect(evidence.filter((item) => item.kind === 'diff').map((item) => item.id)).toEqual(
			expect.arrayContaining(['diff:internal.js', 'diff:package.json', 'diff:readme.md']),
		)
		expect(evidence.find((item) => item.kind === 'commit')?.text).toContain(
			'fix Node compatibility',
		)
		expect(evidence.some((item) => item.id === 'diff:index.js')).toBe(false)
		const research = await collectEvidence(
			repository,
			repository.rootPackage,
			releases.at(-1)!,
			[],
			false,
		)
		expect(research.some((item) => item.kind === 'diff')).toBe(false)
		expect(research[0]?.kind).toBe('range')
		expect(research[0]?.text).toContain('git show')
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
		expect(evidence.find((item) => item.id === 'diff:pnpm-lock.yaml')?.text).toContain(
			'Dependency lockfile changed',
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
		const awaitedResult4 = await resolveReleases(repository, repository.packages[1]!, {})
		expect(awaitedResult4.map((release) => release.version)).toEqual(['2.0.0'])
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
		expect(evidence.some((item) => item.id === 'diff:packages/b/index.js')).toBe(true)
	})
})
