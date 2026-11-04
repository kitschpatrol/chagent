import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangelogPlan } from '../src/lib/types'
import { changelogHeader } from '../src/lib/changelog'
import { git } from '../src/lib/process'
import { reviewChangelog } from '../src/lib/review'
import { writeChangelog } from '../src/lib/write'
import { createRepository, writeFiles } from './helpers'

const { select } = vi.hoisted(() => ({ select: vi.fn() }))
vi.mock('@clack/prompts', () => ({
	isCancel: (value: unknown) => typeof value === 'symbol',
	select,
}))

const directories: string[] = []
const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

afterEach(async () => {
	vi.restoreAllMocks()
	select.mockReset()
	for (const [stream, descriptor] of [
		[process.stdin, inputDescriptor],
		[process.stdout, outputDescriptor],
	] as const) {
		if (descriptor === undefined) {
			Reflect.deleteProperty(stream, 'isTTY')
		} else {
			Object.defineProperty(stream, 'isTTY', descriptor)
		}
	}

	await Promise.all(
		directories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })),
	)
})

async function reviewPlan(): Promise<ChangelogPlan> {
	const root = await createRepository()
	directories.push(root)
	Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
	Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
	return {
		checkpoints: [],
		diagnostics: [],
		files: [
			{
				after: changelogHeader + '\n## Unreleased\n\n### Added\n\n- Generated description.\n',
				path: path.join(root, 'changelog.md'),
			},
		],
		head: await git(root, ['rev-parse', 'HEAD']),
		releases: [],
		root,
	}
}

describe('interactive review', () => {
	it('applies the saved editor content only after acceptance', async () => {
		const plan = await reviewPlan()
		await writeFiles(plan.root, {
			'editor.cjs':
				"const fs = require('node:fs'); const file = process.argv[2]; fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Generated description.', 'Human description.'));",
		})
		select.mockResolvedValueOnce('edit').mockResolvedValueOnce('accept')
		const reviewed = await reviewChangelog(plan, {
			editor: `"${process.execPath}" "${path.join(plan.root, 'editor.cjs')}"`,
		})
		expect(reviewed?.files[0]?.after).toContain('Human description.')
		expect(plan.files[0]?.after).toContain('Generated description.')
		await expect(readFile(plan.files[0]!.path)).rejects.toThrow()
		await writeChangelog(reviewed!)
		expect(await readFile(plan.files[0]!.path, 'utf8')).toContain('Human description.')
	})

	it('cancels without writing repository files', async () => {
		const plan = await reviewPlan()
		select.mockResolvedValueOnce('cancel')
		expect(await reviewChangelog(plan)).toBeUndefined()
		await expect(readFile(plan.files[0]!.path)).rejects.toThrow()
		expect(await git(plan.root, ['diff', '--cached', '--name-only'])).toBe('')
	})
})
