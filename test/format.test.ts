import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ChangelogPlan, FileEdit } from '../src/lib/types'
import { git } from '../src/lib/process'
import { readOptional } from '../src/lib/repository'
import { writeChangelog } from '../src/lib/write'
import { createRepository, installFormatter, writeFiles } from './helpers'

const SHARED_CONFIG = '@kitschpatrol/shared-config'
const PRETTIER_CONFIG = '@kitschpatrol/prettier-config'
const WRITTEN = 'New.\n- Entry.\n'
const FORMATTED = 'New.\n* Entry.\n'

async function setup(extraFiles: Record<string, string> = {}) {
	const root = await createRepository({ '.gitignore': 'node_modules/\n', ...extraFiles })
	const file = path.join(root, 'changelog.md')
	return { file, root }
}

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

async function formatterCalls(root: string): Promise<Array<{ file: string; name: string }>> {
	const calls = await readOptional(path.join(root, '.git', 'formatter-calls.jsonl'))
	return z.array(z.object({ file: z.string(), name: z.string() })).parse(
		(calls ?? '')
			.split('\n')
			.filter((line) => line !== '')
			.map((line): unknown => JSON.parse(line)),
	)
}

async function calledFormatters(root: string): Promise<string[]> {
	const calls = await formatterCalls(root)
	return calls.map(({ name }) => name)
}

describe('formatting written changelogs', () => {
	it('formats with the local shared-config', async () => {
		const { file, root } = await setup()
		await installFormatter(root, SHARED_CONFIG)
		const plan = await planFor(root, [{ after: WRITTEN, path: file }])
		await writeChangelog(plan)
		expect(await readFile(file, 'utf8')).toBe(FORMATTED)
		expect(await formatterCalls(root)).toEqual([{ file, name: SHARED_CONFIG }])
		expect(plan.diagnostics).toEqual([])
	})

	it('prefers shared-config when prettier-config is also installed', async () => {
		const { file, root } = await setup()
		await installFormatter(root, SHARED_CONFIG)
		await installFormatter(root, PRETTIER_CONFIG)
		await writeChangelog(await planFor(root, [{ after: WRITTEN, path: file }]))
		expect(await calledFormatters(root)).toEqual([SHARED_CONFIG])
	})

	it.each([
		['is not installed', undefined],
		['throws on import', 'throw new Error("Broken install.")\n'],
		['has no fixFile export', 'export const other = 1\n'],
	])('falls through to prettier-config when shared-config %s', async (_label, source) => {
		const { file, root } = await setup()
		if (source !== undefined) {
			await installFormatter(root, SHARED_CONFIG, source)
		}

		await installFormatter(root, PRETTIER_CONFIG)
		const plan = await planFor(root, [{ after: WRITTEN, path: file }])
		await writeChangelog(plan)
		expect(await readFile(file, 'utf8')).toBe(FORMATTED)
		expect(await calledFormatters(root)).toEqual([PRETTIER_CONFIG])
		expect(plan.diagnostics).toEqual([])
	})

	it('falls through when a manifest has no import entry', async () => {
		const { file, root } = await setup()
		await writeFiles(root, { [`node_modules/${SHARED_CONFIG}/package.json`]: '{"main":"x.js"}' })
		await installFormatter(root, PRETTIER_CONFIG)
		await writeChangelog(await planFor(root, [{ after: WRITTEN, path: file }]))
		expect(await calledFormatters(root)).toEqual([PRETTIER_CONFIG])
	})

	it('leaves files as written without a local package, despite the one chagent has', async () => {
		const { file, root } = await setup()
		const plan = await planFor(root, [{ after: WRITTEN, path: file }])
		await writeChangelog(plan)
		expect(await readFile(file, 'utf8')).toBe(WRITTEN)
		expect(plan.diagnostics).toEqual([])
	})

	it('reports a diagnostic when an installed formatter cannot be imported', async () => {
		const { file, root } = await setup()
		await installFormatter(root, SHARED_CONFIG, 'throw new Error("Broken install.")\n')
		const plan = await planFor(root, [{ after: WRITTEN, path: file }])
		await writeChangelog(plan)
		expect(await readFile(file, 'utf8')).toBe(WRITTEN)
		expect(plan.diagnostics).toHaveLength(1)
		expect(plan.diagnostics[0]).toContain('Could not load a changelog formatter')
		expect(plan.diagnostics[0]).toContain('Broken install.')
	})

	it('keeps the write and formats the rest when one file fails', async () => {
		const { file, root } = await setup({ 'packages/a/index.js': 'export {}\n' })
		const failing = path.join(root, 'packages/a/changelog.md')
		await installFormatter(
			root,
			SHARED_CONFIG,
			String.raw`import fs from 'node:fs'
export async function fixFile(file) {
	if (file.includes('packages')) throw new Error('Cannot parse.')
	fs.writeFileSync(file, 'Formatted.\n')
}
`,
		)
		const plan = await planFor(root, [
			{ after: WRITTEN, path: failing },
			{ after: WRITTEN, path: file },
		])
		const written = await writeChangelog(plan)
		expect(written).toEqual([failing, file])
		expect(await readFile(failing, 'utf8')).toBe(WRITTEN)
		expect(await readFile(file, 'utf8')).toBe('Formatted.\n')
		expect(plan.diagnostics).toHaveLength(1)
		expect(plan.diagnostics[0]).toContain(path.join('packages', 'a', 'changelog.md'))
		expect(plan.diagnostics[0]).toContain('Cannot parse.')
	})

	it('runs only on changelogs this write changed', async () => {
		const { file, root } = await setup({ 'other.md': 'Other.\n- Keep this.\n' })
		await installFormatter(root, SHARED_CONFIG)
		await writeChangelog(await planFor(root, []))
		expect(await formatterCalls(root)).toEqual([])
		await writeChangelog(await planFor(root, [{ after: WRITTEN, path: file }]))
		expect(await formatterCalls(root)).toEqual([{ file, name: SHARED_CONFIG }])
		expect(await readFile(path.join(root, 'other.md'), 'utf8')).toBe('Other.\n- Keep this.\n')
	})
})
