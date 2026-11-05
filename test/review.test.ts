import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangelogPlan } from '../src/lib/types'
import { changelogHeader } from '../src/lib/changelog'
import { git } from '../src/lib/process'
import { previewChangelog, reviewChangelog } from '../src/lib/review'
import { writeChangelog } from '../src/lib/write'
import { createRepository, writeFiles } from './helpers'

const { select } = vi.hoisted(() => ({ select: vi.fn() }))
vi.mock('@clack/prompts', () => ({
	isCancel: (value: unknown) => typeof value === 'symbol',
	select,
}))

const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

afterEach(() => {
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
})

async function reviewPlan(): Promise<ChangelogPlan> {
	const root = await createRepository()
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

describe('diff preview', () => {
	it('shows repository paths in headers and leaves similar content alone', async () => {
		const plan = await reviewPlan()
		const nested = path.join(plan.root, 'packages/a/changelog.md')
		plan.files = [{ after: '- See before/packages/a/changelog.md.\n', path: nested }]
		const preview = await previewChangelog(plan)
		expect(preview.split('\n', 1)[0]).toBe(
			'diff --git a/packages/a/changelog.md b/packages/a/changelog.md',
		)
		expect(preview).toContain('\n--- a/packages/a/changelog.md\n')
		expect(preview).toContain('\n+++ b/packages/a/changelog.md\n')
		expect(preview).toContain('+- See before/packages/a/changelog.md.')
	})
})

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
