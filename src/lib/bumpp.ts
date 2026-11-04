import type { VersionBumpOptions } from 'bumpp'
import type { GenerateOptions } from './types'
import { generateChangelog } from './generate'
import { git } from './process'
import { reviewChangelog } from './review'
import { writeChangelog } from './write'

const TAG_TOKEN = /\{(version|oldVersion|tag|releaseType|major|minor|patch|date)\}/gv

type ExecuteHook = Exclude<NonNullable<VersionBumpOptions['execute']>, string>
export type BumppHookOptions = Omit<GenerateOptions, 'cwd' | 'release'> & {
	editor?: string
	interactive?: boolean
}

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
	const named = TAG_TOKEN
	if (template.match(named) !== null) {
		tokens.tag = template.replaceAll(named, (_match, key: string) => tokens[key]!)
		return template.replaceAll(named, (_match, key: string) => tokens[key]!)
	}

	return template.includes('%s') ? template.replaceAll('%s', () => version) : template + version
}

/**
 * Generate changelogs inside bumpp's execute phase and include only their
 * files.
 */
export function createBumppHook(options: BumppHookOptions = {}): ExecuteHook {
	return async (operation) => {
		let plan = await generateChangelog({
			...options,
			cwd: operation.options.cwd,
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
		if (options.interactive === true) {
			const reviewed = await reviewChangelog(plan, { editor: options.editor })
			if (reviewed === undefined) {
				throw new Error('Changelog review cancelled. The release has not been committed or tagged.')
			}

			plan = reviewed
		}

		const files = await writeChangelog(plan)
		if (files.length === 0) {
			return
		}

		await git(plan.root, ['add', '--', ...files])
		operation.update({ updatedFiles: [...new Set([...operation.state.updatedFiles, ...files])] })
	}
}
