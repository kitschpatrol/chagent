import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { log } from './log'
import { readOptional } from './repository'

type FixFile = (file: string) => Promise<void>

const FORMATTER_PACKAGES = ['@kitschpatrol/shared-config', '@kitschpatrol/prettier-config']
const manifestSchema = z.object({
	exports: z.object({ '.': z.object({ import: z.string() }) }),
})
const formatterSchema = z.object({
	fixFile: z.custom<FixFile>((value) => typeof value === 'function'),
})

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Import a formatter from the repository rather than from chagent's own
 * dependencies, which a bare import specifier would resolve to.
 */
async function importFixFile(root: string, name: string): Promise<FixFile | undefined> {
	const directory = path.join(root, 'node_modules', name)
	const manifest = await readOptional(path.join(directory, 'package.json'))
	if (manifest === undefined) {
		return undefined
	}

	const { exports } = manifestSchema.parse(JSON.parse(manifest))
	const entry = pathToFileURL(path.join(directory, exports['.'].import)).href
	return formatterSchema.parse(await import(entry)).fixFile
}

async function loadFormatter(
	root: string,
): Promise<{ failures: string[]; fixFile?: FixFile; name?: string }> {
	const failures: string[] = []
	for (const name of FORMATTER_PACKAGES) {
		try {
			const fixFile = await importFixFile(root, name)
			if (fixFile !== undefined) {
				return { failures, fixFile, name }
			}
		} catch (error) {
			log.debug(`Could not import ${name}: ${errorMessage(error)}`)
			failures.push(`${name}: ${errorMessage(error)}`)
		}
	}

	return { failures }
}

/**
 * Format written changelogs with the repository's own shared configuration,
 * when it has one. A failure leaves files as written and adds a diagnostic.
 */
export async function formatChangelogs(
	root: string,
	files: string[],
	diagnostics: string[],
): Promise<void> {
	if (files.length === 0) {
		return
	}

	const { failures, fixFile, name } = await loadFormatter(root)
	if (fixFile === undefined) {
		if (failures.length > 0) {
			diagnostics.push(
				`Could not load a changelog formatter, so changelogs remain as written. ${failures.join(' ')}`,
			)
		}

		return
	}

	for (const file of files) {
		try {
			await fixFile(file)
			log.debug(`Formatted ${file} with ${name}.`)
		} catch (error) {
			diagnostics.push(
				`Could not format ${path.relative(root, file)} with ${name}, so it remains as written. ${errorMessage(error)}`,
			)
		}
	}
}
