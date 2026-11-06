import { versionBump, versionBumpInfo } from 'bumpp'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentAdapter } from '../src/lib/types'
import { amendRelease } from '../src/lib/amend'
import { createBumppHook } from '../src/lib/bumpp'
import { generateChangelog } from '../src/lib/generate'
import { git } from '../src/lib/process'
import { commit, createRepository, installFormatter, writeFiles } from './helpers'

const agent: AgentAdapter = {
	async generate(request) {
		await Promise.resolve()
		return {
			releases: request.releases.map((release) => ({
				changes: [
					{
						breaking: false,
						category: 'Added',
						description: 'Support examples.',
						sources: [release.evidence[0]!.id],
					},
				],
				id: release.id,
			})),
		}
	},
	name: 'fixture',
}
const bumpedManifest = '{"name":"example","version":"1.0.1","engines":{"node":">=18"}}'

/** Create an unpublished, version-only release commit at HEAD. */
async function releaseCommit(files: Record<string, string> = {}): Promise<string> {
	const root = await createRepository()
	await git(root, ['tag', 'v1.0.0'])
	await writeFiles(root, { 'package.json': bumpedManifest, ...files })
	await commit(root, 'Release: 1.0.1')
	return root
}

describe('release integration', () => {
	it('includes new changelogs in the bumpp commit and tag without consuming unrelated staged work', async () => {
		const root = await createRepository({ 'unrelated.txt': 'original\n' })
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Improve behavior.')
		await writeFiles(root, { 'unrelated.txt': 'User work.\n' })
		await git(root, ['add', 'unrelated.txt'])
		// Bumpp's Git operations use process.cwd(); isolate this test by restoring it immediately.
		const previous = process.cwd()
		process.chdir(root)
		try {
			await versionBump({
				commit: 'Release: {version}',
				confirm: false,
				cwd: root,
				execute: createBumppHook({ agent, editor: 'unused', github: false, interactive: false }),
				ignoreScripts: true,
				interface: false,
				push: false,
				release: '1.0.1',
				tag: 'v{version}',
			})
		} finally {
			process.chdir(previous)
		}

		expect(await git(root, ['show', 'v1.0.1:changelog.md'])).toContain('Support examples.')
		expect(await git(root, ['show', 'HEAD:unrelated.txt'])).toBe('original')
		expect(await git(root, ['diff', '--cached', '--name-only'])).toBe('unrelated.txt')
	})

	it('commits the formatted changelog through bumpp', async () => {
		const root = await createRepository({ '.gitignore': 'node_modules/\n' })
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Improve behavior.')
		await installFormatter(root, '@kitschpatrol/shared-config')
		const previous = process.cwd()
		process.chdir(root)
		try {
			await versionBump({
				commit: 'Release: {version}',
				confirm: false,
				cwd: root,
				execute: createBumppHook({ agent, editor: 'unused', github: false, interactive: false }),
				ignoreScripts: true,
				interface: false,
				push: false,
				release: '1.0.1',
				tag: 'v{version}',
			})
		} finally {
			process.chdir(previous)
		}

		expect(await git(root, ['show', 'v1.0.1:changelog.md'])).toContain('* Support examples.')
		expect(await git(root, ['status', '--porcelain'])).toBe('')
	})

	it('amends with the formatted changelog', async () => {
		const root = await createRepository({ '.gitignore': 'node_modules/\n' })
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'package.json': bumpedManifest })
		await commit(root, 'Release: 1.0.1')
		await installFormatter(root, '@kitschpatrol/shared-config')
		await amendRelease(await generateChangelog({ agent, cwd: root, github: false }))
		expect(await git(root, ['show', 'HEAD:changelog.md'])).toContain('* Support examples.')
		expect(await git(root, ['status', '--porcelain'])).toBe('')
	})

	it('reports progress and diagnostics from the bumpp hook on stderr', async () => {
		const root = await createRepository({ '.gitignore': 'node_modules/\n' })
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Improve behavior.')
		await installFormatter(
			root,
			'@kitschpatrol/shared-config',
			'export async function fixFile() { throw new Error("The formatter failed.") }\n',
		)
		let output = ''
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			output += String(chunk)
			return true
		})
		const previous = process.cwd()
		process.chdir(root)
		try {
			await versionBump({
				commit: 'Release: {version}',
				confirm: false,
				cwd: root,
				execute: createBumppHook({ agent, github: false }),
				ignoreScripts: true,
				interface: false,
				push: false,
				release: '1.0.1',
				tag: 'v{version}',
			})
		} finally {
			process.chdir(previous)
			stderr.mockRestore()
		}

		expect(output).toContain('Researching 2 release ranges in 1 shared agent session.')
		expect(output).toContain('The formatter failed.')
	})

	it('refuses interactive review without a terminal before generating', async () => {
		const root = await createRepository()
		const generate = vi.fn(agent.generate)
		const hook = createBumppHook({ agent: { ...agent, generate }, interactive: true })
		await expect(hook(await versionBumpInfo({ cwd: root, release: '1.0.1' }))).rejects.toThrow(
			'Interactive review requires a terminal',
		)
		expect(generate).not.toHaveBeenCalled()
	})

	it('stops bumpp before committing or tagging if generation fails', async () => {
		const root = await createRepository()
		const head = await git(root, ['rev-parse', 'HEAD'])
		const previous = process.cwd()
		process.chdir(root)
		try {
			await expect(
				versionBump({
					commit: true,
					confirm: false,
					cwd: root,
					execute: createBumppHook({
						agent: {
							async generate() {
								await Promise.resolve()
								throw new Error('Generation failed.')
							},
							name: 'failure',
						},
						github: false,
					}),
					ignoreScripts: true,
					interface: false,
					push: false,
					release: '1.0.1',
					tag: true,
				}),
			).rejects.toThrow('Generation failed')
		} finally {
			process.chdir(previous)
		}

		expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head)
		expect(await git(root, ['tag'])).toBe('')
	})

	it('amends an unpublished bump and preserves tag annotation and unrelated staged changes', async () => {
		const root = await createRepository({ 'unrelated.txt': 'original\n' })
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, {
			'package.json': '{"name":"example","version":"1.0.1","engines":{"node":">=18"}}',
		})
		await commit(root, 'Release: 1.0.1')
		await git(root, ['tag', '-a', 'v1.0.1', '-m', 'Release annotation.'])
		const oldHead = await git(root, ['rev-parse', 'HEAD'])
		await writeFiles(root, { 'unrelated.txt': 'Staged user work.\n' })
		await git(root, ['add', 'unrelated.txt'])
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		const head = await amendRelease(plan)
		expect(head).not.toBe(oldHead)
		expect(await git(root, ['rev-parse', 'v1.0.1^{}'])).toBe(head)
		expect(await git(root, ['cat-file', '-p', 'v1.0.1'])).toContain('Release annotation.')
		expect(await git(root, ['diff', '--cached', '--name-only'])).toBe('unrelated.txt')
	})

	it.each(['1.0.1', 'v1.0.1'])(
		'amends a release committed with the subject %s, as npm version writes it',
		async (subject) => {
			const root = await createRepository()
			await git(root, ['tag', 'v1.0.0'])
			await writeFiles(root, { 'package.json': bumpedManifest })
			await commit(root, subject)
			await git(root, ['tag', 'v1.0.1'])
			const plan = await generateChangelog({ agent, cwd: root, github: false })
			const head = await amendRelease(plan)
			expect(head).not.toBe(plan.head)
			expect(await git(root, ['rev-parse', 'v1.0.1'])).toBe(head)
			expect(await git(root, ['show', 'HEAD:changelog.md'])).toContain('Support examples.')
		},
	)

	it.each([
		[
			'the repository configuration',
			{ 'chagent.config.json': '{"tagPatterns":["release-{version}"]}' },
			{},
		],
		['the options generation was given', {}, { tagPatterns: ['release-{version}'] }],
	])('moves a release tag that follows tag patterns from %s', async (_label, files, options) => {
		const root = await createRepository(files)
		await git(root, ['tag', 'release-1.0.0'])
		await writeFiles(root, { 'package.json': bumpedManifest })
		await commit(root, 'Release: 1.0.1')
		await git(root, ['tag', 'release-1.0.1'])
		const plan = await generateChangelog({ agent, cwd: root, github: false, ...options })
		expect(plan.releases.map((release) => release.tag)).toEqual(['release-1.0.0', 'release-1.0.1'])
		const head = await amendRelease(plan, options)
		expect(await git(root, ['rev-parse', 'release-1.0.1'])).toBe(head)
		expect(await git(root, ['rev-parse', 'release-1.0.0'])).not.toBe(head)
	})

	it('refuses to move a tag that only default patterns would read as the release', async () => {
		const root = await createRepository({
			'chagent.config.json': '{"tagPatterns":["release-{version}"]}',
		})
		await git(root, ['tag', 'release-1.0.0'])
		await writeFiles(root, { 'package.json': bumpedManifest })
		await commit(root, 'Release: 1.0.1')
		await git(root, ['tag', 'v1.0.1'])
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		await expect(amendRelease(plan)).rejects.toThrow('unrelated tag (v1.0.1)')
	})

	it('rejects ordinary commits even when amendment is explicitly requested', async () => {
		const root = await createRepository()
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		await expect(amendRelease(plan)).rejects.toThrow('exactly one parent')
		await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
	})

	it('refuses to rewrite a release already advertised by a remote', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, {
			'package.json': '{"name":"example","version":"1.0.1","engines":{"node":">=18"}}',
		})
		await commit(root, 'Release: 1.0.1')
		await git(root, ['tag', 'v1.0.1'])
		const remote = path.join(root, 'remote.git')
		await git(root, ['clone', '--bare', root, remote])
		await git(root, ['remote', 'add', 'origin', remote])
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		await expect(amendRelease(plan)).rejects.toThrow('already advertised')
		expect(await git(root, ['rev-parse', 'HEAD'])).toBe(plan.head)
		await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
	})

	it('restores the original commit when a tag moves during amendment', async () => {
		const root = await releaseCommit()
		await git(root, ['tag', 'v1.0.1'])
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		const hooks = path.join(root, '.git', 'no-hooks')
		await mkdir(hooks, { recursive: true })
		const hook = path.join(hooks, 'post-commit')
		await writeFile(hook, '#!/bin/sh\ngit tag --force v1.0.1 v1.0.0\n')
		await chmod(hook, 0o755)
		await expect(amendRelease(plan)).rejects.toThrow('Could not retarget the release tags')
		expect(await git(root, ['rev-parse', 'HEAD'])).toBe(plan.head)
		expect(await readFile(path.join(root, 'changelog.md'), 'utf8')).toContain('Support examples.')
	})

	it('refuses to move a signed tag', async () => {
		const root = await releaseCommit()
		await git(root, [
			'tag',
			'-a',
			'v1.0.1',
			'-m',
			'Release.\n\n-----BEGIN PGP SIGNATURE-----\nNot a real signature.\n-----END PGP SIGNATURE-----',
		])
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		await expect(amendRelease(plan)).rejects.toThrow('Tag v1.0.1 is signed')
		expect(await git(root, ['rev-parse', 'HEAD'])).toBe(plan.head)
		await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
	})

	it('refuses to move an unrelated tag at HEAD', async () => {
		const root = await releaseCommit()
		await git(root, ['tag', 'deployed-to-production'])
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		await expect(amendRelease(plan)).rejects.toThrow('unrelated tag (deployed-to-production)')
	})

	it('refuses a release commit that changes other files', async () => {
		const root = await releaseCommit({ 'index.js': 'export const answer = 43\n' })
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		await expect(amendRelease(plan)).rejects.toThrow('also changes index.js')
	})

	it('refuses a release commit that changes more than the manifest version', async () => {
		const root = await releaseCommit({
			'package.json': '{"name":"example","version":"1.0.1","engines":{"node":">=20"}}',
		})
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		await expect(amendRelease(plan)).rejects.toThrow('changes more than the version')
	})

	it('refuses a commit that does not look like a release', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'package.json': bumpedManifest })
		await commit(root, 'Tweak the package.')
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		await expect(amendRelease(plan)).rejects.toThrow('recognizable release commit message')
	})

	it('refuses a detached HEAD', async () => {
		const root = await releaseCommit()
		await git(root, ['checkout', '-q', '--detach'])
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		await expect(amendRelease(plan)).rejects.toThrow('checked-out branch')
	})
})
