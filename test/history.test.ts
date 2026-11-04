import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { collectEvidence } from '../src/lib/evidence'
import { git } from '../src/lib/process'
import { hasNodeException, inspectRepository, resolveReleases } from '../src/lib/repository'
import { commit, createRepository, writeFiles } from './helpers'

const directories: string[] = []
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })),
	)
})

describe('release history', () => {
	it('includes the initial release and uses the predecessor of a tag at HEAD', async () => {
		const root = await createRepository()
		directories.push(root)
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
		directories.push(root)
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Fix the answer.')
		let repository = await inspectRepository(root)
		expect((await resolveReleases(repository, repository.rootPackage, {})).at(-1)?.version).toBe(
			'Unreleased',
		)
		await writeFiles(root, { 'package.json': '{"name":"example","version":"1.0.1"}' })
		repository = await inspectRepository(root)
		expect((await resolveReleases(repository, repository.rootPackage, {})).at(-1)).toMatchObject({
			pending: true,
			version: '1.0.1',
		})
	})

	it('does not treat Node upgrades in major releases as exceptions', async () => {
		const root = await createRepository()
		directories.push(root)
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
		directories.push(root)
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'CHANGELOG.md': '# Changelog\n\nInvented release descriptions.\n' })
		await commit(root, 'Generate release notes.')
		const repository = await inspectRepository(root)
		const release = (await resolveReleases(repository, repository.rootPackage, {})).at(-1)!
		expect(await collectEvidence(repository, repository.rootPackage, release)).toEqual([])
	})

	it('discovers pnpm packages and their independent tags', async () => {
		const root = await createRepository({
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'packages/b/package.json': '{"name":"@example/b","version":"2.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		directories.push(root)
		await git(root, ['tag', '@example/a@1.0.0'])
		await git(root, ['tag', '@example/b@2.0.0'])
		const repository = await inspectRepository(root)
		expect(repository.packages.map((pkg) => pkg.name)).toEqual(['@example/a', '@example/b'])
		expect(
			(await resolveReleases(repository, repository.packages[1]!, {})).map(
				(release) => release.version,
			),
		).toEqual(['2.0.0'])
	})
})
