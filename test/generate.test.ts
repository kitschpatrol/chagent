import { readFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAdapter, GenerationRequest } from '../src/lib/types'
import { changelogHeader, parseChangelog } from '../src/lib/changelog'
import { generateChangelog } from '../src/lib/generate'
import { git } from '../src/lib/process'
import { previewChangelog } from '../src/lib/review'
import { writeChangelog } from '../src/lib/write'
import { commit, createRepository, writeFiles } from './helpers'

const directories: string[] = []
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })),
	)
})

function fixtureAgent(): AgentAdapter & {
	generate: ReturnType<typeof vi.fn<AgentAdapter['generate']>>
} {
	return {
		cacheKey: 'fixture-1',
		generate: vi.fn(async (request: GenerationRequest) => {
			await Promise.resolve()
			return [
				{
					breaking: false,
					category: 'Changed',
					description: `Improve ${request.packageName} in ${request.version}.`,
					sources: [request.evidence[0]!.id],
				},
			]
		}),
		name: 'fixture',
	}
}

describe('generation and writing', () => {
	it('creates history, previews without writing, and makes a repeated run a no-op', async () => {
		const root = await createRepository()
		directories.push(root)
		await git(root, ['tag', 'v1.0.0'])
		const agent = fixtureAgent()
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		expect(plan.files).toHaveLength(1)
		expect(await previewChangelog(plan)).toContain('Improve example in 1.0.0.')
		await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
		await writeChangelog(plan)
		const calls = agent.generate.mock.calls.length
		const awaitedResult1 = await generateChangelog({ agent, cwd: root, github: false })
		expect(awaitedResult1.files).toEqual([])
		expect(agent.generate).toHaveBeenCalledTimes(calls)
	})

	it('preserves human history and draft notes when a release is bumped', async () => {
		const history = '## [1.0.0] - 2026-01-01\n\n### Fixed\n\n* Keep  this handcrafted entry.\n\n'
		const root = await createRepository({
			'CHANGELOG.md':
				changelogHeader + '\n## [Unreleased]\n\n### Added\n\n- A human note.\n\n' + history,
		})
		directories.push(root)
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Fix the answer.')
		await writeFiles(root, { 'package.json': '{"name":"example","version":"1.0.1"}' })
		const plan = await generateChangelog({ agent: fixtureAgent(), cwd: root, github: false })
		expect(plan.files[0]?.path).toBe(path.join(root, 'CHANGELOG.md'))
		expect(plan.files[0]?.after).toContain(history)
		expect(plan.files[0]?.after).toContain('- A human note.')
		expect(parseChangelog(plan.files[0]!.after).sections.map((section) => section.version)).toEqual(
			['1.0.1', '1.0.0'],
		)
	})

	it('keeps incremental Unreleased updates idempotent and preserves saved edits', async () => {
		const root = await createRepository()
		directories.push(root)
		await git(root, ['tag', 'v1.0.0'])
		const agent = fixtureAgent()
		await writeChangelog(await generateChangelog({ agent, cwd: root, github: false }))
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Improve behavior.')
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		plan.files[0]!.after = plan.files[0]!.after.replace(
			'Improve example in Unreleased.',
			'A better human description.',
		)
		await writeChangelog(plan)
		const again = await generateChangelog({ agent, cwd: root, github: false })
		expect(again.files).toEqual([])
		expect(await readFile(path.join(root, 'changelog.md'), 'utf8')).toContain(
			'A better human description.',
		)
	})

	it('rejects concurrent changes before writing any file', async () => {
		const root = await createRepository()
		directories.push(root)
		const plan = await generateChangelog({ agent: fixtureAgent(), cwd: root, github: false })
		await writeFiles(root, { 'changelog.md': 'Human work in progress.\n' })
		await expect(writeChangelog(plan)).rejects.toThrow('changed during generation')
		expect(await readFile(path.join(root, 'changelog.md'), 'utf8')).toBe(
			'Human work in progress.\n',
		)
	})

	it('rejects a symlink substituted for a changelog', async () => {
		const root = await createRepository()
		directories.push(root)
		const plan = await generateChangelog({ agent: fixtureAgent(), cwd: root, github: false })
		await symlink(path.join(root, 'index.js'), path.join(root, 'changelog.md'))
		await expect(writeChangelog(plan)).rejects.toThrow('not a regular file')
	})

	it('rejects unsupported evidence citations before producing file edits', async () => {
		const root = await createRepository()
		directories.push(root)
		const agent = fixtureAgent()
		agent.generate.mockResolvedValue([
			{ breaking: false, category: 'Added', description: 'Invented.', sources: ['missing'] },
		])
		await expect(generateChangelog({ agent, cwd: root, github: false })).rejects.toThrow(
			'evidence that was not supplied',
		)
		await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
	})

	it('generates per-package history and a shared-version root summary', async () => {
		const root = await createRepository({
			'packages/a/index.js': 'export const a = 1\n',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'packages/b/package.json': '{"name":"@example/b","version":"1.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		directories.push(root)
		await git(root, ['tag', 'v1.0.0'])
		const plan = await generateChangelog({ agent: fixtureAgent(), cwd: root, github: false })
		expect(plan.files).toHaveLength(3)
		expect(
			plan.files.find((file) => file.path === path.join(root, 'changelog.md'))?.after,
		).toContain('packages/a/changelog.md#100--')
		await writeChangelog(plan)
		const awaitedResult2 = await generateChangelog({
			agent: fixtureAgent(),
			cwd: root,
			github: false,
		})
		expect(awaitedResult2.files).toEqual([])
	})

	it('uses package-qualified root entries for independent versions', async () => {
		const root = await createRepository({
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'packages/b/package.json': '{"name":"@example/b","version":"2.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		directories.push(root)
		await git(root, ['tag', '@example/a@1.0.0'])
		await git(root, ['tag', '@example/b@2.0.0'])
		const plan = await generateChangelog({ agent: fixtureAgent(), cwd: root, github: false })
		const rootFile = plan.files.find((file) => file.path === path.join(root, 'changelog.md'))!
		expect(rootFile.after).toContain('## @example/a@1.0.0 - ')
		expect(rootFile.after).toContain('## @example/b@2.0.0 - ')
		await writeChangelog(plan)
		const awaitedResult3 = await generateChangelog({
			agent: fixtureAgent(),
			cwd: root,
			github: false,
		})
		expect(awaitedResult3.files).toEqual([])
	})

	it('backfills root links without rewriting existing package history', async () => {
		const history =
			changelogHeader + '\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- Handwritten package history.\n'
		const root = await createRepository({
			'packages/a/changelog.md': history,
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		directories.push(root)
		await git(root, ['tag', 'v1.0.0'])
		const agent = fixtureAgent()
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		expect(plan.files).toHaveLength(1)
		expect(plan.files[0]?.after).toContain('packages/a/changelog.md#100---2026-01-01')
		expect(await readFile(path.join(root, 'packages/a/changelog.md'), 'utf8')).toBe(history)
		expect(agent.generate.mock.calls.some(([request]) => request.scope === 'repository')).toBe(true)
	})

	it('promotes independent package summaries while preserving root draft edits', async () => {
		const root = await createRepository({
			'packages/a/index.js': 'export const answer = 42\n',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		directories.push(root)
		await git(root, ['tag', '@example/a@1.0.0'])
		const agent = fixtureAgent()
		await writeChangelog(await generateChangelog({ agent, cwd: root, github: false }))
		await writeFiles(root, { 'packages/a/index.js': 'export const answer = 43\n' })
		await commit(root, 'Improve the package.')
		const draft = await generateChangelog({ agent, cwd: root, github: false })
		const rootDraft = draft.files.find((file) => file.path === path.join(root, 'changelog.md'))!
		rootDraft.after = rootDraft.after
			.replace('## Unreleased\n', '## Unreleased\n\nA root note.\n')
			.replace('Improve @example/a in Unreleased.', 'Reviewed package fix.')
		await writeChangelog(draft)
		await writeFiles(root, { 'packages/a/package.json': '{"name":"@example/a","version":"1.0.1"}' })
		await commit(root, 'Release: 1.0.1')
		await git(root, ['tag', '@example/a@1.0.1'])
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		const rootFile = plan.files.find((file) => file.path === path.join(root, 'changelog.md'))!
		const { sections } = parseChangelog(rootFile.after)
		expect(sections.find((section) => section.version === '@example/a@1.0.1')?.body).toContain(
			'Reviewed package fix.',
		)
		expect(sections.find((section) => section.version === 'Unreleased')?.body).toContain(
			'A root note.',
		)
		expect(rootFile.after).not.toContain('@example/a Unreleased')
	})
})
