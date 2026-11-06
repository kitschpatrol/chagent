import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChangelogPlan, FileEdit } from '../src/lib/types'
import { git } from '../src/lib/process'
import { writeChangelog } from '../src/lib/write'
import { commit, createRepository, writeFiles } from './helpers'

async function planFor(root: string, files: FileEdit[]): Promise<ChangelogPlan> {
	return {
		checkpoints: [],
		diagnostics: [],
		files,
		head: await git(root, ['rev-parse', 'HEAD']),
		releases: [],
		root,
	}
}

describe('writing changelogs', () => {
	// Directory permissions do not block writes on Windows.
	it.skipIf(process.platform === 'win32')(
		'restores every file and releases the lock when a later write fails',
		async () => {
			const root = await createRepository({
				'changelog.md': 'Original root.\n',
				'packages/blocked/index.js': 'export {}\n',
				'packages/new/index.js': 'export {}\n',
			})
			const blocked = path.join(root, 'packages/blocked')
			const created = path.join(root, 'packages/new/changelog.md')
			const plan = await planFor(root, [
				{
					after: 'Updated root.\n',
					before: 'Original root.\n',
					path: path.join(root, 'changelog.md'),
				},
				{ after: 'New package.\n', path: created },
				{ after: 'Blocked.\n', path: path.join(blocked, 'changelog.md') },
			])
			await chmod(blocked, 0o500)
			try {
				await expect(writeChangelog(plan)).rejects.toThrow('EACCES')
			} finally {
				await chmod(blocked, 0o700)
			}

			expect(await readFile(path.join(root, 'changelog.md'), 'utf8')).toBe('Original root.\n')
			await expect(readFile(created)).rejects.toThrow('ENOENT')
			await expect(stat(path.join(root, '.git/chagent/write.lock'))).rejects.toThrow('ENOENT')
		},
	)

	it('refuses to write while the lock is held, and leaves the lock in place', async () => {
		const root = await createRepository()
		const lock = path.join(root, '.git/chagent/write.lock')
		await mkdir(path.dirname(lock), { recursive: true })
		await writeFile(lock, '12345')
		const file = path.join(root, 'changelog.md')
		const plan = await planFor(root, [{ after: 'New.\n', path: file }])
		await expect(writeChangelog(plan)).rejects.toThrow('Cannot acquire the changelog write lock')
		await expect(readFile(file)).rejects.toThrow('ENOENT')
		expect(await readFile(lock, 'utf8')).toBe('12345')
	})

	it('releases the lock after a successful write', async () => {
		const root = await createRepository()
		const file = path.join(root, 'changelog.md')
		const written = await writeChangelog(await planFor(root, [{ after: 'New.\n', path: file }]))
		expect(written).toEqual([file])
		expect(await readFile(file, 'utf8')).toBe('New.\n')
		await expect(stat(path.join(root, '.git/chagent/write.lock'))).rejects.toThrow('ENOENT')
	})

	it('refuses to write after HEAD moves', async () => {
		const root = await createRepository()
		const file = path.join(root, 'changelog.md')
		const plan = await planFor(root, [{ after: 'New.\n', path: file }])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Move HEAD.')
		await expect(writeChangelog(plan)).rejects.toThrow('HEAD changed')
		await expect(readFile(file)).rejects.toThrow('ENOENT')
	})

	it.each([
		['a path outside the repository', '../changelog.md'],
		['a file that is not a changelog', 'readme.md'],
	])('rejects %s', async (_name, relative) => {
		const root = await createRepository()
		const plan = await planFor(root, [{ after: 'New.\n', path: path.join(root, relative) }])
		await expect(writeChangelog(plan)).rejects.toThrow('Invalid changelog destination')
	})

	it('keeps written files and reports a diagnostic when a checkpoint cannot be saved', async () => {
		const root = await createRepository()
		const file = path.join(root, 'changelog.md')
		const plan = await planFor(root, [{ after: 'New.\n', path: file }])
		plan.checkpoints.push({
			baseRef: 'initial',
			contentHash: 'hash',
			generated: false,
			head: plan.head,
			instructionVersion: 'version',
			path: file,
		})
		await mkdir(path.join(root, '.git/chagent'), { recursive: true })
		await writeFile(path.join(root, '.git/chagent/checkpoints'), 'Not a directory.\n')
		await writeChangelog(plan)
		expect(await readFile(file, 'utf8')).toBe('New.\n')
		expect(plan.diagnostics).toEqual([
			'Could not save incremental metadata; the next run will recheck the full release range.',
		])
	})
})
