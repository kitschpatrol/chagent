import { isCancel, select } from '@clack/prompts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChangelogPlan } from './types'
import { parseChangelog } from './changelog'
import { git, runCommand } from './process'

async function scratchFiles(
	plan: ChangelogPlan,
	directory: string,
): Promise<Array<{ candidate: string; original: string; relative: string }>> {
	const files: Array<{ candidate: string; original: string; relative: string }> = []
	for (const edit of plan.files) {
		const relative = path.relative(plan.root, edit.path)
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new Error('Review paths must be inside the repository.')
		}

		const original = path.join(directory, 'before', relative)
		const candidate = path.join(directory, 'after', relative)
		await mkdir(path.dirname(original), { recursive: true })
		await mkdir(path.dirname(candidate), { recursive: true })
		await writeFile(original, edit.before ?? '')
		await writeFile(candidate, edit.after)
		files.push({ candidate, original, relative })
	}

	return files
}

/** Produce a unified diff without modifying the repository or index. */
export async function previewChangelog(plan: ChangelogPlan): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'chagent-diff-'))
	try {
		const files = await scratchFiles(plan, directory)
		const diffs: string[] = []
		for (const file of files) {
			const result = await runCommand(
				'git',
				[
					'--no-pager',
					'diff',
					'--no-index',
					'--no-ext-diff',
					'--no-textconv',
					'--color=never',
					'--',
					file.original,
					file.candidate,
				],
				{ allowFailure: true },
			)
			if (result.code > 1) {
				throw new Error(result.stderr)
			}

			diffs.push(
				result.stdout
					.replaceAll(file.original, () => file.relative)
					.replaceAll(file.candidate, () => file.relative),
			)
		}

		return diffs.join('\n')
	} finally {
		await rm(directory, { force: true, recursive: true })
	}
}

/** Review a diff and optionally edit temporary candidates before applying them. */
export async function reviewChangelog(
	plan: ChangelogPlan,
	options: { editor?: string } = {},
): Promise<ChangelogPlan | undefined> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(
			'Interactive review requires a terminal. Use --dry-run to inspect a diff without one.',
		)
	}

	const candidate = structuredClone(plan)
	if (candidate.files.length === 0) {
		return candidate
	}

	const directory = await mkdtemp(path.join(os.tmpdir(), 'chagent-review-'))
	try {
		const files = await scratchFiles(candidate, directory)
		for (;;) {
			process.stdout.write(await previewChangelog(candidate))
			const action = await select({
				message: 'Review changelog changes',
				options: [
					{ label: 'Accept changes', value: 'accept' },
					{ label: 'Edit in the configured editor', value: 'edit' },
					{ label: 'Cancel', value: 'cancel' },
				],
			})
			if (action === 'cancel' || isCancel(action)) {
				return undefined
			}

			if (action === 'accept') {
				return candidate
			}

			const editor = options.editor ?? (await git(plan.root, ['var', 'GIT_EDITOR']))
			for (const [index, file] of files.entries()) {
				// The editor is an explicitly configured command; file paths remain positional arguments.
				const args =
					process.platform === 'win32'
						? ['/d', '/s', '/c', `${editor} "${file.candidate}"`]
						: ['-c', `${editor} "$1"`, 'chagent-editor', file.candidate]
				await runCommand(process.platform === 'win32' ? 'cmd.exe' : 'sh', args, {
					cwd: plan.root,
					inherit: true,
					timeoutMs: 86_400_000,
				})
				const content = await readFile(file.candidate, 'utf8')
				parseChangelog(content)
				candidate.files[index]!.after = content
			}
		}
	} finally {
		await rm(directory, { force: true, recursive: true })
	}
}
