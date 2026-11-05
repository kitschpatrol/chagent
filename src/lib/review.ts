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

/** Show repository paths in a diff's header, leaving its content untouched. */
function repositoryPaths(diff: string, file: string, from: string, to: string): string {
	const hunks = diff.indexOf('\n@@')
	const header = hunks === -1 ? diff : diff.slice(0, hunks)
	const body = hunks === -1 ? '' : diff.slice(hunks)
	return header.replaceAll(from, () => file).replaceAll(to, () => file) + body
}

/** Produce a unified diff without modifying the repository or index. */
export async function previewChangelog(plan: ChangelogPlan): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'chagent-diff-'))
	try {
		const files = await scratchFiles(plan, directory)
		const diffs: string[] = []
		for (const file of files) {
			const relative = file.relative.split(path.sep).join('/')
			const from = `before/${relative}`
			const to = `after/${relative}`
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
					from,
					to,
				],
				{ allowFailure: true, cwd: directory },
			)
			if (result.code > 1) {
				throw new Error(result.stderr)
			}

			diffs.push(repositoryPaths(result.stdout, relative, from, to))
		}

		return diffs.join('\n')
	} finally {
		await rm(directory, { force: true, recursive: true })
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function changelogProblem(plan: ChangelogPlan): string | undefined {
	for (const edit of plan.files) {
		try {
			parseChangelog(edit.after)
		} catch (error) {
			return `${path.relative(plan.root, edit.path)}: ${errorText(error)}`
		}
	}

	return undefined
}

async function openEditor(editor: string, file: string, cwd: string): Promise<void> {
	// The editor is an explicitly configured command; on POSIX, file paths remain positional
	// arguments. cmd.exe parses its own command line, so it gets one verbatim, wrapped in the
	// outer quotes that /s strips.
	const windows = process.platform === 'win32'
	const args = windows
		? ['/d', '/s', '/c', `"${editor} "${file}""`]
		: ['-c', `${editor} "$1"`, 'chagent-editor', file]
	await runCommand(windows ? 'cmd.exe' : 'sh', args, {
		cwd,
		inherit: true,
		timeoutMs: 86_400_000,
		windowsVerbatimArguments: windows,
	})
}

/**
 * Open each candidate in turn. Saved edits are kept even when they are invalid,
 * so a retry can continue from them.
 */
async function editCandidates(
	plan: ChangelogPlan,
	files: Array<{ candidate: string }>,
	editor: string,
): Promise<string | undefined> {
	for (const [index, file] of files.entries()) {
		try {
			await openEditor(editor, file.candidate, plan.root)
		} catch (error) {
			return `The editor reported a failure. ${errorText(error)}`
		} finally {
			plan.files[index]!.after = await readFile(file.candidate, 'utf8')
		}
	}

	return undefined
}

/** Check for a terminal before generation spends an agent session on a review. */
export function assertReviewTerminal(): void {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(
			'Interactive review requires a terminal. Use --dry-run to inspect a diff without one.',
		)
	}
}

/** Review a diff and optionally edit temporary candidates before applying them. */
export async function reviewChangelog(
	plan: ChangelogPlan,
	options: { editor?: string } = {},
): Promise<ChangelogPlan | undefined> {
	assertReviewTerminal()
	const candidate = structuredClone(plan)
	if (candidate.files.length === 0) {
		return candidate
	}

	const directory = await mkdtemp(path.join(os.tmpdir(), 'chagent-review-'))
	try {
		const files = await scratchFiles(candidate, directory)
		let editorFailure: string | undefined
		for (;;) {
			process.stdout.write(await previewChangelog(candidate))
			const problem = changelogProblem(candidate)
			const notice = problem ?? editorFailure
			const action = await select({
				message:
					notice === undefined ? 'Review changelog changes' : `${notice}\nReview changelog changes`,
				options: [
					...(problem === undefined ? [{ label: 'Accept changes', value: 'accept' }] : []),
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
			editorFailure = await editCandidates(candidate, files, editor)
		}
	} finally {
		await rm(directory, { force: true, recursive: true })
	}
}
