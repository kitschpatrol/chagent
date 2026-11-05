import { readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentAdapter, Category, GenerationRequest } from '../src/lib/types'
import { writeCache } from '../src/lib/cache'
import { changelogHeader, parseChangelog } from '../src/lib/changelog'
import { generateChangelog } from '../src/lib/generate'
import { git } from '../src/lib/process'
import { previewChangelog } from '../src/lib/review'
import { writeChangelog } from '../src/lib/write'
import { commit, createRepository, describeReleases, installFormatter, writeFiles } from './helpers'

function fixtureAgent(category: Category = 'Changed'): AgentAdapter & {
	generate: ReturnType<typeof vi.fn<AgentAdapter['generate']>>
} {
	return {
		cacheKey: 'fixture-1',
		generate: vi.fn(async (request: GenerationRequest) => {
			await Promise.resolve()
			return describeReleases(request, category)
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
			const agent = fixtureAgent()
			const plan = await generateChangelog({ agent, cwd: root, github: false })
			expect(
				parseChangelog(plan.files[0]!.after).sections.map((section) => section.version),
			).toEqual(['1.0.0'])
			const session = agent.generate.mock.calls[0]![0]
			const initial = session.releases[0]!
			expect(session.repositoryRoot).toBe(root)
			expect(initial.repository).toMatchObject({ directory: '.', to: plan.head })
			expect(initial.initialRelease).toBe(true)
			expect(initial.evidence[0]?.kind).toBe('range')
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
		expect(agent.generate.mock.calls[0]?.[0].releases[0]).toMatchObject({
			initialRelease: true,
			mode: 'initialize',
			scope: 'package',
		})
		expect(await previewChangelog(plan)).toContain('Improve example in 1.0.0.')
		await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
		await writeChangelog(plan)
		const calls = agent.generate.mock.calls.length
		const repeated = await generateChangelog({ agent, cwd: root, github: false })
		expect(repeated.files).toEqual([])
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

	it('treats a broken package.json fixture changed between releases as source content', async () => {
		const root = await createRepository({ 'test/fixtures/bad/package.json': '{ invalid one' })
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'test/fixtures/bad/package.json': '{ invalid two' })
		await commit(root, 'Update the broken fixture.')
		await git(root, ['tag', 'v1.0.1'])
		const plan = await generateChangelog({ agent: fixtureAgent(), cwd: root, github: false })
		expect(parseChangelog(plan.files[0]!.after).sections[0]?.body).toContain(
			'Improve example in 1.0.1.',
		)
	})

	it('survives a broken root package.json earlier in history', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'package.json': '<<<<<<< HEAD\n{"name":"example"}\n' })
		await commit(root, 'Commit a merge conflict.')
		await writeFiles(root, { 'package.json': '{"name":"example","version":"1.0.0"}' })
		await commit(root, 'Resolve the merge conflict.')
		const plan = await generateChangelog({ agent: fixtureAgent(), cwd: root, github: false })
		expect(parseChangelog(plan.files[0]!.after).sections[0]?.version).toBe('Unreleased')
	})

	it('names the file when a current workspace package.json cannot be parsed', async () => {
		const root = await createRepository({
			'packages/a/package.json': '{ invalid',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await expect(
			generateChangelog({ agent: fixtureAgent(), cwd: root, github: false }),
		).rejects.toThrow('Cannot parse packages/a/package.json')
	})

	it('treats an existing Conventional Changelog file as already recording its releases', async () => {
		const original =
			'# Changelog\n\n# [1.1.0](https://example.com/compare/v1.0.0...v1.1.0) (2026-02-01)\n\n### Features\n\n* A handwritten feature.\n\n## [1.0.0](https://example.com/releases/v1.0.0) (2026-01-01)\n\n### Bug Fixes\n\n* A handwritten fix.\n'
		const root = await createRepository({ 'changelog.md': original })
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Add a feature.')
		await git(root, ['tag', 'v1.1.0'])
		const agent = fixtureAgent()
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		expect(plan.files).toEqual([])
		expect(agent.generate).not.toHaveBeenCalled()
	})

	it('treats standard-version patch headings as already recording their releases', async () => {
		const original =
			'# Changelog\n\n### [1.1.1](https://example.com/compare/v1.1.0...v1.1.1) (2026-02-01)\n\n### Bug Fixes\n\n* A handwritten fix.\n\n## [1.1.0](https://example.com/releases/v1.1.0) (2026-01-01)\n\n### Features\n\n* A handwritten feature.\n'
		const root = await createRepository({ 'changelog.md': original })
		await git(root, ['tag', 'v1.1.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Fix the answer.')
		await git(root, ['tag', 'v1.1.1'])
		const agent = fixtureAgent()
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		expect(plan.files).toEqual([])
		expect(agent.generate).not.toHaveBeenCalled()
	})

	it('names unrecognized release headings', async () => {
		const root = await createRepository({ 'changelog.md': '# Changelog\n\n## Notes\n\n- Text.\n' })
		await expect(
			generateChangelog({ agent: fixtureAgent(), cwd: root, github: false }),
		).rejects.toThrow('unrecognized release headings (Notes)')
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
		expect(agent.generate.mock.calls.at(-1)?.[0].releases[0]).toMatchObject({
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

	it.each([
		['adding a trailing blank line', (text: string) => text + '\n'],
		[
			'adding blank lines between entries',
			(text: string) => text.replaceAll('\n\n', '\n'.repeat(3)),
		],
		['converting to CRLF', (text: string) => text.replaceAll('\n', '\r\n')],
	])('researches only newer commits after %s in the changelog', async (_label, reformat) => {
		const root = await createRepository()
		const agent = fixtureAgent()
		const first = await generateChangelog({ agent, cwd: root, github: false })
		await writeChangelog(first)
		const file = path.join(root, 'changelog.md')
		await writeFile(file, reformat(await readFile(file, 'utf8')))
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Improve behavior.')
		await generateChangelog({ agent, cwd: root, github: false })
		const request = agent.generate.mock.calls.at(-1)?.[0].releases[0]
		expect(request?.repository.from).toBe(first.head)
		expect(request?.evidence.filter(({ kind }) => kind === 'commit')).toHaveLength(1)
	})

	it('researches only newer commits after a formatter changes more than whitespace', async () => {
		const root = await createRepository({ '.gitignore': 'node_modules/\n' })
		await installFormatter(root, '@kitschpatrol/shared-config')
		const agent = fixtureAgent()
		const first = await generateChangelog({ agent, cwd: root, github: false })
		await writeChangelog(first)
		expect(await readFile(path.join(root, 'changelog.md'), 'utf8')).toContain(
			'* Improve example in Unreleased.',
		)
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Improve behavior.')
		await generateChangelog({ agent, cwd: root, github: false })
		const request = agent.generate.mock.calls.at(-1)?.[0].releases[0]
		expect(request?.repository.from).toBe(first.head)
	})

	it('rechecks the full history after changelog text changes', async () => {
		const root = await createRepository()
		const agent = fixtureAgent()
		await writeChangelog(await generateChangelog({ agent, cwd: root, github: false }))
		const file = path.join(root, 'changelog.md')
		const content = await readFile(file, 'utf8')
		await writeFile(file, content.replace('Improve example in Unreleased.', 'Reworded by hand.'))
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Improve behavior.')
		await generateChangelog({ agent, cwd: root, github: false })
		const request = agent.generate.mock.calls.at(-1)?.[0].releases[0]
		expect(request?.repository.from).toBeUndefined()
		expect(request?.existingEntries).toContain('Reworded by hand.')
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
		const request = agent.generate.mock.calls[0]![0].releases[0]!
		expect(request.version).toBe('Unreleased')
		expect(request.existingEntries).toContain('Improve example in Unreleased.')
		expect(request.repository.from).toBe(await git(root, ['rev-parse', 'v1.0.0']))
		expect(
			request.evidence.some(
				(item) => item.kind === 'commit' && item.text.includes('Fix behavior.'),
			),
		).toBe(true)
	})

	it('links a pending release heading before its tag exists', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await git(root, ['remote', 'add', 'origin', 'https://github.com/example/fixture.git'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Change the answer.')
		await writeFiles(root, { 'package.json': '{"name":"example","version":"1.1.0"}' })
		const plan = await generateChangelog({ agent: fixtureAgent(), cwd: root, github: false })
		expect(plan.files[0]?.after).toContain('## [1.1.0] - ')
		expect(plan.files[0]?.after).toContain(
			'[1.1.0]: https://github.com/example/fixture/compare/v1.0.0...v1.1.0',
		)
	})

	it('keeps an existing changelog when a rebuild finds nothing to record', async () => {
		const notes = changelogHeader + '\n## Unreleased\n\n### Added\n\n- A handwritten note.\n'
		const root = await createRepository({ 'changelog.md': notes })
		const agent = fixtureAgent()
		agent.generate.mockImplementation(async (request) => {
			await Promise.resolve()
			return { releases: request.releases.map(({ id }) => ({ changes: [], id })) }
		})
		const plan = await generateChangelog({ agent, cwd: root, github: false, rebuild: true })
		expect(plan.files).toEqual([])
		expect(plan.diagnostics).toEqual([
			'The rebuild found nothing to record in changelog.md, so it was left unchanged.',
		])
		await writeChangelog(plan)
		expect(await readFile(path.join(root, 'changelog.md'), 'utf8')).toBe(notes)
	})

	it.each([
		['maxInputChars', { maxInputChars: 100 }],
		['timeoutMs', { timeoutMs: -1 }],
		['tagPatterns', { tagPatterns: ['v1'] }],
	])('rejects an invalid %s from library callers', async (name, options) => {
		const root = await createRepository()
		await expect(
			generateChangelog({ agent: fixtureAgent(), cwd: root, github: false, ...options }),
		).rejects.toThrow(name)
	})

	it('names the configuration file when its values are invalid', async () => {
		const root = await createRepository({ 'chagent.config.json': '{"effort":"extreme"}' })
		await expect(generateChangelog({ agent: fixtureAgent(), cwd: root })).rejects.toThrow(
			path.join(root, 'chagent.config.json'),
		)
	})

	it('lets library options override the configuration file, except when undefined', async () => {
		const root = await createRepository({
			'chagent.config.json': '{"github":false,"effort":"low"}',
		})
		const agent = fixtureAgent()
		await generateChangelog({ agent, cwd: root, effort: undefined, model: 'chosen' })
		expect(agent.generate.mock.calls[0]?.[0].settings).toMatchObject({
			effort: 'low',
			model: 'chosen',
		})
	})

	it('reuses drafts when only the timeout changes, and regenerates when the effort changes', async () => {
		const root = await createRepository()
		const agent = fixtureAgent()
		const options = { agent, cwd: root, github: false }
		await generateChangelog({ ...options, timeoutMs: 1000 })
		await generateChangelog({ ...options, timeoutMs: 2000 })
		expect(agent.generate).toHaveBeenCalledOnce()
		await generateChangelog({ ...options, effort: 'low', timeoutMs: 2000 })
		expect(agent.generate).toHaveBeenCalledTimes(2)
	})

	it('reports progress between agent sessions, including corrections', async () => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Change the answer.')
		const agent = fixtureAgent()
		agent.generate.mockResolvedValueOnce({ releases: [] })
		const onProgress = vi.fn<(message: string) => void>()
		await generateChangelog({ agent, cwd: root, github: false, onProgress })
		expect(onProgress.mock.calls.map(([message]) => message)).toEqual([
			'Researching 2 release ranges in 1 shared agent session.',
			'Requesting a correction of invalid agent output.',
		])
	})

	it('rejects a symlink substituted for a changelog', async () => {
		const root = await createRepository()
		const plan = await generateChangelog({ agent: fixtureAgent(), cwd: root, github: false })
		await symlink(path.join(root, 'index.js'), path.join(root, 'changelog.md'))
		await expect(writeChangelog(plan)).rejects.toThrow('not a regular file')
	})

	it.each([
		['- A stray bullet.', 'A stray bullet.'],
		['* Another stray bullet.', 'Another stray bullet.'],
		['1. A numbered entry.', 'A numbered entry.'],
		['A wrapped\n  entry\twith  gaps. ', 'A wrapped entry with gaps.'],
	])('normalizes the description %j without a correction request', async (raw, expected) => {
		const root = await createRepository()
		const agent = fixtureAgent()
		agent.generate.mockImplementation(async (request) => {
			await Promise.resolve()
			const { releases } = describeReleases(request)
			releases[0]!.changes[0]!.description = raw
			return { releases }
		})
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		expect(agent.generate).toHaveBeenCalledOnce()
		expect(plan.files[0]?.after).toContain(`- ${expected}\n`)
	})

	it.each([['# A heading.'], ['<!-- Hidden. -->'], ['-   ']])(
		'names the release when the description %j cannot be repaired',
		async (raw) => {
			const root = await createRepository()
			const agent = fixtureAgent()
			agent.generate.mockImplementation(async (request) => {
				await Promise.resolve()
				const { releases } = describeReleases(request)
				releases[0]!.changes[0]!.description = raw
				return { releases }
			})
			await expect(generateChangelog({ agent, cwd: root, github: false })).rejects.toThrow(
				'Agent output for .@Unreleased has an empty description, heading, or hidden markup',
			)
		},
	)

	it('rejects unsupported evidence citations before producing file edits', async () => {
		const root = await createRepository()
		const agent = fixtureAgent()
		agent.generate.mockImplementation(async (request) => {
			await Promise.resolve()
			return {
				releases: request.releases.map(({ id }) => ({
					changes: [
						{ breaking: false, category: 'Added', description: 'Invented.', sources: ['missing'] },
					],
					id,
				})),
			}
		})
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
		const repeated = await generateChangelog({
			agent: fixtureAgent(),
			cwd: root,
			github: false,
		})
		expect(repeated.files).toEqual([])
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
		const repeated = await generateChangelog({
			agent: fixtureAgent(),
			cwd: root,
			github: false,
		})
		expect(repeated.files).toEqual([])
	})

	it('applies a release context from a package directory to that package only', async () => {
		const root = await createRepository({
			'packages/a/index.js': 'export const a = 1\n',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'packages/b/package.json': '{"name":"@example/b","version":"2.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await git(root, ['tag', '@example/a@1.0.0'])
		await git(root, ['tag', '@example/b@2.0.0'])
		const agent = fixtureAgent()
		await writeChangelog(await generateChangelog({ agent, cwd: root, github: false }))
		await writeFiles(root, { 'packages/a/index.js': 'export const a = 2\n' })
		await commit(root, 'Improve a.')
		await writeFiles(root, { 'packages/a/package.json': '{"name":"@example/a","version":"1.0.1"}' })
		const plan = await generateChangelog({
			agent,
			cwd: path.join(root, 'packages/a'),
			github: false,
			release: { tag: '@example/a@1.0.1', version: '1.0.1' },
		})
		const rootFile = plan.files.find((file) => file.path === path.join(root, 'changelog.md'))!
		expect(parseChangelog(rootFile.after).sections.map((section) => section.version)).toEqual([
			'@example/a@1.0.1',
			'@example/b@2.0.0',
			'@example/a@1.0.0',
		])
		expect(plan.releases.find((release) => release.version === '1.0.1')?.tag).toBe(
			'@example/a@1.0.1',
		)
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
		agent.generate.mockImplementation(async (request) => {
			await Promise.resolve()
			return { releases: request.releases.map(({ id }) => ({ changes: [], id })) }
		})
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		expect(plan.files).toHaveLength(1)
		expect(plan.files[0]?.after).toContain('packages/a/changelog.md#100---2026-01-01')
		expect(plan.files[0]?.after).toContain('### Maintenance')
		expect(plan.files[0]?.after).not.toContain('### Changed')
		expect(await readFile(path.join(root, 'packages/a/changelog.md'), 'utf8')).toBe(history)
		expect(
			agent.generate.mock.calls.some(([request]) =>
				request.releases.some((release) => release.scope === 'repository'),
			),
		).toBe(true)
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
