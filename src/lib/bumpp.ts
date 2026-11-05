import type { VersionBumpOptions } from 'bumpp'
import type { ChangelogPlan, GenerateOptions } from './types'
import { generateChangelog } from './generate'
import { git } from './process'
import { createProgressLine } from './progress'
import { assertReviewTerminal, reviewChangelog } from './review'
import { writeChangelog } from './write'

const TAG_TOKEN = /\{(version|oldVersion|tag|releaseType|major|minor|patch|date)\}/gv

type ExecuteHook = Exclude<NonNullable<VersionBumpOptions['execute']>, string>
export type BumppHookOptions = Omit<GenerateOptions, 'cwd' | 'release'> & {
	editor?: string
	interactive?: boolean
}

/** Mirror bumpp's tag rendering, which it does not export. */
function tagName(
	template: string | undefined,
	version: string,
	oldVersion: string,
	releaseType = '',
): string | undefined {
	if (template === undefined) {
		return undefined
	}

	const now = new Date()
	const [major = '', minor = '', patch = ''] = version.split('-', 1)[0]!.split('.', 3)
	const tokens: Record<string, string> = {
		date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
		major,
		minor,
		oldVersion,
		patch,
		releaseType,
		tag: '',
		version,
	}
	const rendered = template.replaceAll(TAG_TOKEN, (_match, key: string) => tokens[key]!)
	if (rendered !== template) {
		return rendered
	}

	return template.includes('%s') ? template.replaceAll('%s', () => version) : template + version
}

/**
 * Generate changelogs inside bumpp's execute phase and include only their
 * files. Progress and diagnostics go to stderr, unless `onProgress` is given to
 * handle status messages.
 */
export function createBumppHook(options: BumppHookOptions = {}): ExecuteHook {
	const { editor, interactive, onProgress, ...generateOptions } = options
	return async (operation) => {
		if (interactive === true) {
			assertReviewTerminal()
		}

		const progress =
			onProgress === undefined && process.stderr.isTTY
				? createProgressLine(process.stderr)
				: undefined
		progress?.start('Reading repository history.')
		let plan: ChangelogPlan
		try {
			plan = await generateChangelog({
				...generateOptions,
				cwd: operation.options.cwd,
				onProgress:
					onProgress ??
					((message) => {
						if (progress === undefined) {
							process.stderr.write(`${message}\n`)
						} else {
							progress.update(message)
						}
					}),
				release: {
					tag: tagName(
						operation.options.tag?.name,
						operation.state.newVersion,
						operation.state.currentVersion,
						operation.state.release,
					),
					version: operation.state.newVersion,
				},
			})
		} finally {
			progress?.stop()
		}

		try {
			if (interactive === true) {
				const reviewed = await reviewChangelog(plan, { editor })
				if (reviewed === undefined) {
					throw new Error(
						'Changelog review cancelled. The release has not been committed or tagged.',
					)
				}

				plan = reviewed
			}

			const files = await writeChangelog(plan)
			if (files.length === 0) {
				return
			}

			await git(plan.root, ['add', '--', ...files])
			operation.update({ updatedFiles: [...new Set([...operation.state.updatedFiles, ...files])] })
		} finally {
			for (const diagnostic of plan.diagnostics) {
				process.stderr.write(`${diagnostic}\n`)
			}
		}
	}
}
