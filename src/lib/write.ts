import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ChangelogPlan, FileEdit } from './types'
import { hash, writeCache } from './cache'
import { git } from './process'
import { readOptional } from './repository'

async function verifyFile(root: string, edit: FileEdit): Promise<void> {
	const relative = path.relative(root, edit.path)
	if (
		relative.startsWith('..') ||
		path.isAbsolute(relative) ||
		path.basename(edit.path).toLowerCase() !== 'changelog.md'
	) {
		throw new Error(`Invalid changelog destination: ${edit.path}`)
	}

	const directory = await realpath(path.dirname(edit.path))
	if (directory !== root && !directory.startsWith(root + path.sep)) {
		throw new Error(`Changelog directory escapes the repository: ${edit.path}`)
	}

	const metadata = await fileMetadata(edit.path)

	if (metadata?.isSymbolicLink() === true || (metadata !== undefined && !metadata.isFile())) {
		throw new Error(`Changelog destination is not a regular file: ${edit.path}`)
	}

	if ((await readOptional(edit.path)) !== edit.before) {
		throw new Error(
			`Changelog changed during generation or review: ${edit.path}. Run chagent again to preserve those edits.`,
		)
	}
}

async function replaceFile(file: string, content: string): Promise<void> {
	const temporary = `${file}.chagent-${crypto.randomUUID()}.tmp`
	try {
		const metadata = await fileMetadata(file)
		await writeFile(temporary, content, { flag: 'wx', mode: metadata?.mode ?? 0o644 })
		await rename(temporary, file)
	} finally {
		await rm(temporary, { force: true })
	}
}

/**
 * Apply reviewed edits, rejecting concurrent changes and rolling back failed
 * writes.
 */
export async function writeChangelog(plan: ChangelogPlan): Promise<string[]> {
	const root = await realpath(plan.root)
	if ((await git(root, ['rev-parse', 'HEAD'])) !== plan.head) {
		throw new Error('HEAD changed during generation or review. Run chagent again.')
	}

	const gitDirectory = await git(root, ['rev-parse', '--absolute-git-dir'])
	const stateDirectory = path.join(gitDirectory, 'chagent')
	await mkdir(stateDirectory, { recursive: true })
	const lockPath = path.join(stateDirectory, 'write.lock')
	const lock = await acquireLock(lockPath)

	const applied: FileEdit[] = []
	try {
		await lock.writeFile(String(process.pid))
		for (const edit of plan.files) {
			await verifyFile(root, edit)
		}

		for (const edit of plan.files) {
			await verifyFile(root, edit)
			await replaceFile(edit.path, edit.after)
			applied.push(edit)
		}

		for (const checkpoint of plan.checkpoints) {
			const edit = plan.files.find((file) => file.path === checkpoint.path)
			try {
				await writeCache(path.join(stateDirectory, 'checkpoints'), checkpoint.path, {
					...checkpoint,
					contentHash: edit === undefined ? checkpoint.contentHash : hash(edit.after),
				})
			} catch {
				plan.diagnostics.push(
					'Could not save incremental metadata; the next run will recheck the full release range.',
				)
			}
		}

		return applied.map((edit) => edit.path)
	} catch (error) {
		for (const edit of applied.toReversed()) {
			if ((await readOptional(edit.path)) !== edit.after) {
				continue
			}

			if (edit.before === undefined) {
				await rm(edit.path)
			} else {
				await replaceFile(edit.path, edit.before)
			}
		}

		throw error
	} finally {
		await lock.close()
		await rm(lockPath, { force: true })
	}
}

async function fileMetadata(file: string) {
	try {
		return await lstat(file)
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return
		}

		throw error
	}
}

async function acquireLock(file: string) {
	try {
		return await open(file, 'wx')
	} catch (error) {
		throw new Error(
			`Cannot acquire the changelog write lock at ${file}. Another write may be running; remove a stale lock only after it has stopped.`,
			{ cause: error },
		)
	}
}
