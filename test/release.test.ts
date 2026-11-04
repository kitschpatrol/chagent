import { versionBump } from 'bumpp'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAdapter } from '../src/lib/types'
import { amendRelease } from '../src/lib/amend'
import { createBumppHook } from '../src/lib/bumpp'
import { generateChangelog } from '../src/lib/generate'
import { git } from '../src/lib/process'
import { commit, createRepository, writeFiles } from './helpers'

const agent: AgentAdapter = {
	async generate(request) {
		await Promise.resolve()
		return [
			{
				breaking: false,
				category: 'Added',
				description: 'Support examples.',
				sources: [request.evidence[0]!.id],
			},
		]
	},
	name: 'fixture',
}
const directories: string[] = []
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })),
	)
})

describe('release integration', () => {
	it('includes new changelogs in the bumpp commit and tag without consuming unrelated staged work', async () => {
		const root = await createRepository({ 'unrelated.txt': 'original\n' })
		directories.push(root)
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
				execute: createBumppHook({ agent, github: false }),
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

	it('stops bumpp before committing or tagging if generation fails', async () => {
		const root = await createRepository()
		directories.push(root)
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
		directories.push(root)
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

	it('rejects ordinary commits even when amendment is explicitly requested', async () => {
		const root = await createRepository()
		directories.push(root)
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		await expect(amendRelease(plan)).rejects.toThrow('exactly one parent')
		await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
	})

	it('refuses to rewrite a release already advertised by a remote', async () => {
		const root = await createRepository()
		directories.push(root)
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
})
