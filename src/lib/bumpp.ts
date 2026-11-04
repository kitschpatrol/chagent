import type { VersionBumpOptions } from 'bumpp'
import type { GenerateOptions } from './types'
import { generateChangelog } from './generate'
import { git } from './process'
import { reviewChangelog } from './review'
import { writeChangelog } from './write'

const TAG_TOKEN = /\{(version|oldVersion|major|minor|patch|date)\}/gv

type ExecuteHook = Exclude<NonNullable<VersionBumpOptions['execute']>, string>
export type BumppHookOptions = Omit<GenerateOptions, 'cwd' | 'release'> & {
	editor?: string
	interactive?: boolean
}

function tagName(
	template: string | undefined,
	version: string,
	oldVersion: string,
): string | undefined {
	if (template === undefined) {
		return undefined
	}

	const tokens: Record<string, string> = {
		date: new Date().toISOString().slice(0, 10),
		major: version.split('.', 1)[0]!,
		minor: version.split('.', 2)[1]!,
		oldVersion,
		patch: version.split('.', 3)[2]!,
		version,
	}
	const named = TAG_TOKEN
	if (template.includes('{')) {
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
