import { readFile, symlink } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentAdapter, Category, GenerationRequest } from '../src/lib/types'
import { writeCache } from '../src/lib/cache'
import { changelogHeader, parseChangelog } from '../src/lib/changelog'
import { generateChangelog } from '../src/lib/generate'
import { git } from '../src/lib/process'
import { previewChangelog } from '../src/lib/review'
import { writeChangelog } from '../src/lib/write'
import { commit, createRepository, writeFiles } from './helpers'

function fixtureAgent(category: Category = 'Changed'): AgentAdapter & {
	generate: ReturnType<typeof vi.fn<AgentAdapter['generate']>>
} {
	return {
		cacheKey: 'fixture-1',
		generate: vi.fn(async (request: GenerationRequest) => {
			await Promise.resolve()
			return [
				{
					breaking: false,
					category,
					description: `Improve ${request.packageName} in ${request.version}.`,
					sources: [request.evidence[0]!.id],
				},
			]
		}),
		name: 'fixture',
	}
}

describe('generation and writing', () => {
	it.each(['python', 'rust', 'plain Git'])(
		'initializes and updates a %s project without npm metadata',
		async (language) => {
			const implementations: Record<string, Record<string, string>> = {
				'plain Git': { 'manual.txt': 'The original instructions.\n' },
				python: {
					'example.py': 'def answer():\n    return 42\n',
					'pyproject.toml': '[project]\nname = "example"\nversion = "1.0.0"\n',
				},
				rust: {
					'Cargo.toml': '[package]\nname = "example"\nversion = "1.0.0"\n',
					'src/lib.rs': 'pub fn answer() -> u32 { 42 }\n',
				},
			}
			const root = await createRepository(implementations[language], false)
			await git(root, ['tag', 'v1.0.0'])
			const agent = { ...fixtureAgent(), repositoryAccess: true }
			const plan = await generateChangelog({ agent, cwd: root, github: false })
			expect(
				parseChangelog(plan.files[0]!.after).sections.map((section) => section.version),
			).toEqual(['1.0.0'])
			const initial = agent.generate.mock.calls[0]![0]
			expect(initial.repository).toMatchObject({ directory: '.', root, to: plan.head })
			expect(initial.initialRelease).toBe(true)
			expect(initial.evidence[0]?.kind).toBe('range')
			expect(initial.evidence.some((item) => item.kind === 'diff')).toBe(false)
			await writeChangelog(plan)
			await writeFiles(root, { 'readme.md': 'New installation guidance.\n' })
			await commit(root, 'Document installation.')
			await git(root, ['tag', 'v1.0.1'])
			const update = await generateChangelog({ agent, cwd: root, github: false })
			expect(
				parseChangelog(update.files[0]!.after).sections.map((section) => section.version),
			).toEqual(['1.0.1', '1.0.0'])
			expect(update.files[0]?.after).toContain(
				plan.files[0]!.after.slice(plan.files[0]!.after.indexOf('## ')),
			)
			await expect(readFile(path.join(root, 'package.json'))).rejects.toThrow()
		},
	)

	it('supports explicitly configured non-npm workspace directories and their tags', async () => {
		const root = await createRepository(
			{
				'projects/client/client.py': 'def answer():\n    return 42\n',
				'projects/engine/src/lib.rs': 'pub fn answer() -> u32 { 42 }\n',
			},
			false,
		)
		await git(root, ['tag', 'engine@1.0.0'])
		await git(root, ['tag', 'client@2.0.0'])
		const plan = await generateChangelog({
			agent: fixtureAgent(),
			cwd: root,
			github: false,
			packages: ['projects/*'],
		})
		expect(plan.files).toHaveLength(3)
		expect(
			plan.files.find((file) => file.path === path.join(root, 'changelog.md'))?.after,
		).toContain('## engine@1.0.0')
		expect(
			plan.files.find((file) => file.path === path.join(root, 'projects/client/changelog.md'))
				?.after,
		).toContain('## 2.0.0 - ')
	})
	it('creates history, previews without writing, and makes a repeated run a no-op', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		const agent = fixtureAgent()
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		expect(plan.files).toHaveLength(1)
		expect(agent.generate.mock.calls[0]?.[0]).toMatchObject({
			initialRelease: true,
			mode: 'initialize',
			scope: 'package',
		})
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

	it('moves draft notes into a new tagged release without copying them to Unreleased', async () => {
		const root = await createRepository({
			'changelog.md':
				changelogHeader +
				'\n## Unreleased\n\n### Added\n\n- A human note.\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- Old.\n\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Change the answer.')
		await git(root, ['tag', 'v1.0.1'])
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Change the answer again.')
		const plan = await generateChangelog({ agent: fixtureAgent(), cwd: root, github: false })
		const { sections } = parseChangelog(plan.files[0]!.after)
		expect(sections.map((section) => section.version)).toEqual(['Unreleased', '1.0.1', '1.0.0'])
		expect(sections[1]?.body).toContain('A human note.')
		expect(sections[0]?.body).not.toContain('A human note.')
		expect(sections[0]?.body).toContain('Improve example in Unreleased.')
	})

	it('keeps incremental Unreleased updates idempotent and preserves saved edits', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		const agent = fixtureAgent()
		await writeChangelog(await generateChangelog({ agent, cwd: root, github: false }))
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Improve behavior.')
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		expect(agent.generate.mock.calls.at(-1)?.[0]).toMatchObject({
			initialRelease: false,
			mode: 'update',
		})
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

	it.each(['single', 'shared', 'independent'] as const)(
		'rebuilds %s history only when explicitly requested and keeps it reviewable',
		async (layout) => {
			const history =
				changelogHeader + '\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- Handcrafted history.\n'
			const files: Record<string, string> = { 'changelog.md': history }
			if (layout !== 'single') {
				files['pnpm-workspace.yaml'] = 'packages:\n  - packages/*\n'
				files['packages/a/package.json'] = '{"name":"@example/a","version":"1.0.0"}'
				files['packages/a/changelog.md'] = history
				if (layout === 'independent') {
					files['changelog.md'] = history.replace('[1.0.0]', '@example/a@1.0.0')
				}
			}

			const root = await createRepository(files)
			await git(root, ['tag', layout === 'independent' ? '@example/a@1.0.0' : 'v1.0.0'])
			const agent = fixtureAgent()
			const original = await generateChangelog({ agent, cwd: root, github: false })
			expect(original.files).toEqual([])
			const rebuilt = await generateChangelog({ agent, cwd: root, github: false, rebuild: true })
			expect(rebuilt.files).toHaveLength(layout === 'single' ? 1 : 2)
			for (const file of rebuilt.files) {
				expect(file.before).toContain('Handcrafted history.')
				expect(file.after).not.toContain('Handcrafted history.')
				expect(file.after).toContain('Improve ')
				expect(await readFile(file.path, 'utf8')).toBe(file.before)
				expect(parseChangelog(file.after).sections).toHaveLength(1)
			}

			expect(await previewChangelog(rebuilt)).toContain('- Handcrafted history.')
		},
	)

	it('rejects concurrent changes before writing any file', async () => {
		const root = await createRepository()
		const plan = await generateChangelog({ agent: fixtureAgent(), cwd: root, github: false })
		await writeFiles(root, { 'changelog.md': 'Human work in progress.\n' })
		await expect(writeChangelog(plan)).rejects.toThrow('changed during generation')
		expect(await readFile(path.join(root, 'changelog.md'), 'utf8')).toBe(
			'Human work in progress.\n',
		)
	})

	it('rechecks Unreleased evidence after generation instructions change', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		const agent = fixtureAgent()
		await writeChangelog(await generateChangelog({ agent, cwd: root, github: false }))
		await writeFiles(root, { 'index.js': 'export const answer = 45\n' })
		await commit(root, 'Fix behavior.')
		const draft = await generateChangelog({ agent, cwd: root, github: false })
		await writeChangelog(draft)
		const checkpoint = draft.checkpoints[0]!
		await writeCache(path.join(root, '.git', 'chagent', 'checkpoints'), checkpoint.path, {
			...checkpoint,
			instructionVersion: 'old',
		})
		agent.generate.mockClear()
		agent.cacheKey = undefined
		await generateChangelog({ agent, cwd: root, github: false })
		expect(agent.generate).toHaveBeenCalledOnce()
		const request = agent.generate.mock.calls[0]![0]
		expect(request.version).toBe('Unreleased')
		expect(request.existingEntries).toContain('Improve example in Unreleased.')
		expect(
			request.evidence.some(
				(item) => item.kind === 'diff' && item.text.includes('+export const answer = 45'),
			),
		).toBe(true)
	})

	it('rejects a symlink substituted for a changelog', async () => {
		const root = await createRepository()
		const plan = await generateChangelog({ agent: fixtureAgent(), cwd: root, github: false })
		await symlink(path.join(root, 'index.js'), path.join(root, 'changelog.md'))
		await expect(writeChangelog(plan)).rejects.toThrow('not a regular file')
	})

	it('rejects unsupported evidence citations before producing file edits', async () => {
		const root = await createRepository()
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
		await git(root, ['tag', 'v1.0.0'])
		const agent = fixtureAgent()
		agent.generate.mockResolvedValue([])
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		expect(plan.files).toHaveLength(1)
		expect(plan.files[0]?.after).toContain('packages/a/changelog.md#100---2026-01-01')
		expect(plan.files[0]?.after).toContain('### Maintenance')
		expect(plan.files[0]?.after).not.toContain('### Changed')
		expect(await readFile(path.join(root, 'packages/a/changelog.md'), 'utf8')).toBe(history)
		expect(agent.generate.mock.calls.some(([request]) => request.scope === 'repository')).toBe(true)
	})

	it.each(['Changed', 'Documentation', 'Maintenance'] as const)(
		'promotes independent %s package summaries while preserving root draft edits',
		async (category) => {
			const root = await createRepository({
				'packages/a/index.js': 'export const answer = 42\n',
				'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
				'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
			})
			await git(root, ['tag', '@example/a@1.0.0'])
			const agent = fixtureAgent(category)
			await writeChangelog(await generateChangelog({ agent, cwd: root, github: false }))
			await writeFiles(root, { 'packages/a/index.js': 'export const answer = 43\n' })
			await commit(root, 'Improve the package.')
			const draft = await generateChangelog({ agent, cwd: root, github: false })
			const rootDraft = draft.files.find((file) => file.path === path.join(root, 'changelog.md'))!
			rootDraft.after = rootDraft.after
				.replace('## Unreleased\n', '## Unreleased\n\nA root note.\n')
				.replace('Improve @example/a in Unreleased.', 'Reviewed package fix.')
			await writeChangelog(draft)
			await writeFiles(root, {
				'packages/a/package.json': '{"name":"@example/a","version":"1.0.1"}',
			})
			await commit(root, 'Release: 1.0.1')
			await git(root, ['tag', '@example/a@1.0.1'])
			const plan = await generateChangelog({ agent, cwd: root, github: false })
			const rootFile = plan.files.find((file) => file.path === path.join(root, 'changelog.md'))!
			const { sections } = parseChangelog(rootFile.after)
			expect(sections.find((section) => section.version === '@example/a@1.0.1')?.body).toContain(
				`### ${category}`,
			)
			expect(sections.find((section) => section.version === '@example/a@1.0.1')?.body).toContain(
				'Reviewed package fix.',
			)
			expect(sections.find((section) => section.version === 'Unreleased')?.body).toContain(
				'A root note.',
			)
			expect(rootFile.after).not.toContain('@example/a Unreleased')
		},
	)
})
