import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentAdapter, Category, ChangelogPlan, GenerationRequest } from '../src/lib/types'
import { writeCache } from '../src/lib/cache'
import { changelogHeader, parseChangelog } from '../src/lib/changelog'
import { assertSupportedNode, generateChangelog } from '../src/lib/generate'
import { git } from '../src/lib/process'
import { previewChangelog } from '../src/lib/review'
import { writeChangelog } from '../src/lib/write'
import { commit, createRepository, describeReleases, installFormatter, writeFiles } from './helpers'

const ISO_DATE = /\d{4}-\d{2}-\d{2}/gv

/** Read a section's body without the dates of today's fixture commits. */
function undated(body = ''): string {
	return body.trim().replaceAll(ISO_DATE, 'DATE')
}

/** The changelogs a plan edits, relative to the root with forward slashes. */
function changelogPaths(plan: ChangelogPlan, root: string): string[] {
	return plan.files
		.map((file) => path.relative(root, file.path).split(path.sep).join('/'))
		.toSorted()
}

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

	it('asks the agent about a release whose only changes are in a directory that usually holds generated output', async () => {
		const root = await createRepository(
			{ 'coverage/core.py': 'def run():\n    return 1\n', 'readme.md': 'A tool.\n' },
			false,
		)
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'coverage/core.py': 'def run():\n    return 2\n' })
		await commit(root, 'Fix the result of run().')
		await git(root, ['tag', 'v1.0.1'])
		const agent = fixtureAgent()
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		const requested = agent.generate.mock.calls[0]![0].releases.find(
			(release) => release.version === '1.0.1',
		)
		expect(requested?.evidence.map((item) => item.kind)).toEqual(['range'])
		const [latest] = parseChangelog(plan.files[0]!.after).sections
		expect(latest?.version).toBe('1.0.1')
		expect(latest?.body).toContain('Improve ')
		expect(latest?.body).not.toContain('No notable changes.')
	})

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

	it.each(['## 1.1', '## v1.1', '## [1.1] - 2026-02-01'])(
		'updates a changelog that records two-part tags under the heading %s',
		async (heading) => {
			const history = `${heading}\n\n- A handwritten change.\n\n${heading.replace('1.1', '1.0')}\n\n- The first release.\n`
			const root = await createRepository({ 'main.py': 'answer = 1\n' }, false)
			await git(root, ['tag', 'v1.0'])
			await writeFiles(root, {
				'changelog.md': `# Changelog\n\n${history}`,
				'main.py': 'answer = 2\n',
			})
			await commit(root, 'Change the answer.')
			await git(root, ['tag', 'v1.1'])
			const agent = fixtureAgent()
			const options = { agent, cwd: root, github: false }
			const recorded = await generateChangelog(options)
			expect(recorded.files).toEqual([])
			expect(agent.generate).not.toHaveBeenCalled()
			await writeFiles(root, { 'main.py': 'answer = 3\n' })
			await commit(root, 'Change the answer again.')
			const plan = await generateChangelog(options)
			expect(plan.files[0]?.after).toContain(history)
			expect(
				parseChangelog(plan.files[0]!.after).sections.map((section) => section.version),
			).toEqual(['Unreleased', '1.1.0', '1.0.0'])
		},
	)

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

	/** Release 1.0.0, then draft one unreleased change without writing it. */
	async function generatedDraft() {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		const agent = fixtureAgent()
		const options = { agent, cwd: root, github: false }
		await writeChangelog(await generateChangelog(options))
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Add a second answer.')
		const draft = await generateChangelog(options)
		return { agent, draft, options, root }
	}

	/** Answer the next request with one change for its first release. */
	function answerOnce(
		agent: ReturnType<typeof fixtureAgent>,
		description: string | undefined,
		sources: (release: GenerationRequest['releases'][number]) => string[],
	): void {
		agent.generate.mockImplementationOnce(async (request) => {
			await Promise.resolve()
			const [release] = request.releases
			const changes =
				description === undefined
					? []
					: [
							{
								breaking: false,
								category: 'Added' as const,
								description,
								sources: sources(release!),
							},
						]
			return { releases: [{ changes, id: release!.id }] }
		})
	}

	it('lets the agent rewrite a draft that only chagent has written', async () => {
		const { agent, draft, options, root } = await generatedDraft()
		expect(agent.generate.mock.calls.at(-1)?.[0].releases[0]?.mode).toBe('update')
		await writeChangelog(draft)
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Fix the second answer.')
		answerOnce(agent, 'Add a second, correct answer.', (release) => [
			'draft',
			release.evidence.at(-1)!.id,
		])
		const revised = await generateChangelog(options)
		const request = agent.generate.mock.calls.at(-1)![0].releases[0]!
		expect(request.mode).toBe('revise')
		expect(request.existingEntries).toContain('Improve example in Unreleased.')
		expect(request.repository.from).toBe(draft.head)
		expect(request.evidence.map((item) => item.kind)).toEqual(['range', 'draft', 'commit'])
		expect(parseChangelog(revised.files[0]!.after).sections[0]?.body.trim()).toBe(
			'### Added\n\n- Add a second, correct answer.',
		)
		// A revised draft is still chagent's own, so the next run can revise it again.
		await writeChangelog(revised)
		await writeFiles(root, { 'index.js': 'export const answer = 45\n' })
		await commit(root, 'Change the answer again.')
		await generateChangelog(options)
		expect(agent.generate.mock.calls.at(-1)?.[0].releases[0]?.mode).toBe('revise')
	})

	it('only adds to a draft that was edited before it was written', async () => {
		const { agent, draft, options, root } = await generatedDraft()
		draft.files[0]!.after = draft.files[0]!.after.replace(
			'Improve example in Unreleased.',
			'A reviewed description.',
		)
		await writeChangelog(draft)
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Fix the second answer.')
		answerOnce(agent, 'A generated addition.', (release) => [release.evidence[0]!.id])
		const plan = await generateChangelog(options)
		const request = agent.generate.mock.calls.at(-1)![0].releases[0]!
		expect(request.mode).toBe('update')
		expect(request.repository.from).toBe(draft.head)
		expect(request.evidence.map((item) => item.kind)).toEqual(['range', 'commit'])
		expect(parseChangelog(plan.files[0]!.after).sections[0]?.body.trim()).toBe(
			'### Added\n\n- A generated addition.\n\n### Changed\n\n- A reviewed description.',
		)
	})

	it('only adds to a draft that began with handwritten notes', async () => {
		const root = await createRepository({
			'changelog.md':
				changelogHeader +
				'\n## Unreleased\n\n### Added\n\n- A handwritten note.\n\n## [1.0.0] - 2026-01-01\n\n- First.\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Add a second answer.')
		const agent = fixtureAgent('Added')
		const options = { agent, cwd: root, github: false }
		const first = await generateChangelog(options)
		await writeChangelog(first)
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Fix the second answer.')
		answerOnce(agent, 'A generated addition.', (release) => [release.evidence[0]!.id])
		const plan = await generateChangelog(options)
		const request = agent.generate.mock.calls.at(-1)![0].releases[0]!
		expect(request.mode).toBe('update')
		expect(request.repository.from).toBe(first.head)
		expect(plan.files[0]?.after).toContain(
			'- A handwritten note.\n- Improve example in Unreleased.\n- A generated addition.\n',
		)
	})

	it('rewrites a generated draft into the release that promotes it', async () => {
		const { agent, draft, options, root } = await generatedDraft()
		await writeChangelog(draft)
		await writeFiles(root, { 'index.js': 'export const answer = 44\n' })
		await commit(root, 'Fix the second answer.')
		await writeFiles(root, { 'package.json': '{"name":"example","version":"1.1.0"}' })
		answerOnce(agent, 'Add a second, correct answer.', () => ['draft'])
		const plan = await generateChangelog(options)
		const request = agent.generate.mock.calls.at(-1)![0].releases[0]!
		expect(request).toMatchObject({ mode: 'revise', version: '1.1.0' })
		const { sections } = parseChangelog(plan.files[0]!.after)
		expect(sections.map((section) => section.version)).toEqual(['1.1.0', '1.0.0'])
		expect(sections[0]?.body.trim()).toBe('### Added\n\n- Add a second, correct answer.')
	})

	it('removes a generated draft when the agent finds that nothing in it still holds', async () => {
		const { agent, draft, options, root } = await generatedDraft()
		await writeChangelog(draft)
		await writeFiles(root, { 'index.js': 'export const answer = 42\n' })
		await commit(root, 'Remove the second answer.')
		answerOnce(agent, undefined, () => [])
		const plan = await generateChangelog(options)
		expect(agent.generate.mock.calls.at(-1)?.[0].releases[0]?.mode).toBe('revise')
		expect(parseChangelog(plan.files[0]!.after).sections.map((section) => section.version)).toEqual(
			['1.0.0'],
		)
	})

	it('revises a generated root draft of repository changes in an independent monorepo', async () => {
		const root = await createRepository({
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
			'readme.md': 'One.\n',
		})
		await git(root, ['tag', '@example/a@1.0.0'])
		const agent = fixtureAgent()
		const options = { agent, cwd: root, github: false }
		await writeChangelog(await generateChangelog(options))
		for (const text of ['Two.\n', 'Three.\n']) {
			await writeFiles(root, { 'readme.md': text })
			await commit(root, `Rewrite the readme: ${text.trim()}`)
			await writeChangelog(await generateChangelog(options))
		}

		const [drafted, revised] = agent.generate.mock.calls
			.slice(-2)
			.map(([request]) => request.releases.find((release) => release.id === '.@Unreleased'))
		expect(drafted?.mode).toBe('update')
		expect(revised?.mode).toBe('revise')
		expect(revised?.evidence.map((item) => item.kind)).toEqual(['range', 'draft', 'commit'])
	})

	it('shows the agent a recent release section as a style reference, except when rebuilding', async () => {
		const root = await createRepository({
			'changelog.md':
				changelogHeader +
				'\n## Unreleased\n\n- A draft.\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n* added the first answer (#1)\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Change the answer.')
		const agent = fixtureAgent()
		const options = { agent, cache: false, cwd: root, github: false }
		await generateChangelog(options)
		expect(agent.generate.mock.calls[0]![0].releases[0]?.styleReference).toBe(
			'### Added\n\n* added the first answer (#1)',
		)
		await generateChangelog({ ...options, rebuild: true })
		expect(
			agent.generate.mock.calls[1]![0].releases.map((release) => release.styleReference),
		).toEqual([undefined, undefined])
	})

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
		const rechecked = await generateChangelog({ agent, cwd: root, github: false })
		expect(agent.generate).toHaveBeenCalledOnce()
		const request = agent.generate.mock.calls[0]![0].releases[0]!
		expect(request.version).toBe('Unreleased')
		expect(request.mode).toBe('update')
		expect(request.existingEntries).toContain('Improve example in Unreleased.')
		expect(request.repository.from).toBe(await git(root, ['rev-parse', 'v1.0.0']))
		expect(
			request.evidence.some(
				(item) => item.kind === 'commit' && item.text.includes('Fix behavior.'),
			),
		).toBe(true)
		// The draft is still chagent's own, so once it is rechecked, a later run can revise it.
		await writeChangelog(rechecked)
		await writeFiles(root, { 'index.js': 'export const answer = 46\n' })
		await commit(root, 'Fix behavior again.')
		await generateChangelog({ agent, cwd: root, github: false })
		expect(agent.generate.mock.calls.at(-1)?.[0].releases[0]?.mode).toBe('revise')
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

	it.each(['24.16.0', '26.13.0', '27.0.0-pre'])('accepts Node.js %s', (version) => {
		expect(() => {
			assertSupportedNode(version)
		}).not.toThrow()
	})

	it.each(['22.23.4', '24.15.0', '26.2.0'])('refuses Node.js %s', (version) => {
		expect(() => {
			assertSupportedNode(version)
		}).toThrow(`chagent requires Node.js ^24.16.0 || >=26.3.0, but this is Node.js ${version}.`)
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
		['timeout', { timeout: -1 }],
		['timeout', { timeout: 50_000 }],
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

	it('gives agent sessions the timeout in milliseconds', async () => {
		const root = await createRepository()
		const agent = fixtureAgent()
		const options = { agent, cache: false, cwd: root, github: false }
		await generateChangelog(options)
		await generateChangelog({ ...options, timeout: 1.5 })
		expect(agent.generate.mock.calls.map(([request]) => request.settings.timeoutMs)).toEqual([
			1_200_000, 90_000,
		])
	})

	it('reuses drafts when only the timeout changes, and regenerates when the effort changes', async () => {
		const root = await createRepository()
		const agent = fixtureAgent()
		const options = { agent, cwd: root, github: false }
		await generateChangelog({ ...options, timeout: 1 })
		await generateChangelog({ ...options, timeout: 2 })
		expect(agent.generate).toHaveBeenCalledOnce()
		await generateChangelog({ ...options, effort: 'low', timeout: 2 })
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
			'cites no supplied evidence or commit in its range: missing',
		)
		await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
	})

	/** Tag a release, then add commits with long messages. */
	async function unreleasedCommits(): Promise<{ commits: string[]; root: string }> {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		for (let index = 1; index <= 12; index += 1) {
			await writeFiles(root, { 'index.js': `export const answer = ${index}\n` })
			await commit(root, `Change the answer to ${index}. ${'Explain it at length. '.repeat(20)}`)
		}

		const commits = await git(root, ['rev-list', '--reverse', 'v1.0.0..HEAD'])
		return { commits: commits.split('\n'), root }
	}

	/** Describe the Unreleased range by citing sources chosen from its request. */
	function citingAgent(cite: (release: GenerationRequest['releases'][number]) => string[]) {
		const agent = fixtureAgent()
		agent.generate.mockImplementation(async (request) => {
			await Promise.resolve()
			const { releases } = describeReleases(request)
			for (const [index, release] of request.releases.entries()) {
				if (release.version === 'Unreleased') {
					releases[index]!.changes[0]!.sources = cite(release)
				}
			}

			return { releases }
		})
		return agent
	}

	it('accepts a commit the agent found in the range, though the input budget left it out', async () => {
		const { commits, root } = await unreleasedCommits()
		const [oldest] = commits
		const agent = citingAgent(() => [oldest!])
		const plan = await generateChangelog({ agent, cwd: root, github: false, maxInputChars: 4000 })
		expect(agent.generate).toHaveBeenCalledOnce()
		const supplied = agent.generate.mock.calls[0]![0].releases.flatMap((release) =>
			release.evidence.map((item) => item.id),
		)
		expect(supplied).not.toContain(oldest)
		expect(plan.releases.find((release) => release.version === 'Unreleased')?.changes).toEqual([
			expect.objectContaining({ sources: [oldest] }),
		])
	})

	it('completes abbreviated commit citations and drops sources that do not hold up', async () => {
		const { commits, root } = await unreleasedCommits()
		const newest = commits.at(-1)!
		const agent = citingAgent(() => [newest.slice(0, 12).toUpperCase(), 'missing', newest])
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		expect(agent.generate).toHaveBeenCalledOnce()
		expect(plan.releases.find((release) => release.version === 'Unreleased')?.changes).toEqual([
			expect.objectContaining({ sources: [newest] }),
		])
	})

	it('requests a correction when a change cites only a commit from another release', async () => {
		const { root } = await unreleasedCommits()
		const first = await git(root, ['rev-parse', 'v1.0.0'])
		const agent = citingAgent(() => [first])
		agent.generate.mockImplementationOnce(agent.generate.getMockImplementation()!)
		agent.generate.mockImplementation(async (request) => {
			await Promise.resolve()
			return describeReleases(request)
		})
		await generateChangelog({ agent, cwd: root, github: false })
		expect(agent.generate).toHaveBeenCalledTimes(2)
		expect(agent.generate.mock.calls[1]![0].repair?.error).toContain(
			`for .@Unreleased cites no supplied evidence or commit in its range: ${first}`,
		)
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

	it('leaves packages without notable changes out of a shared-version root summary', async () => {
		const root = await createRepository({
			'packages/a/index.js': 'export const a = 1\n',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'packages/b/package.json': '{"name":"@example/b","version":"1.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		const agent = fixtureAgent()
		await writeChangelog(await generateChangelog({ agent, cwd: root, github: false }))
		await writeFiles(root, { 'packages/a/index.js': 'export const a = 2\n' })
		await commit(root, 'Improve a.')
		await writeFiles(root, {
			'package.json': '{"engines":{"node":">=18"},"name":"example","version":"1.0.1"}',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.1"}',
			'packages/b/package.json': '{"name":"@example/b","version":"1.0.1"}',
		})
		const plan = await generateChangelog({ agent, cwd: root, github: false })
		const edit = (file: string) => plan.files.find((item) => item.path === path.join(root, file))
		expect(edit('packages/b/changelog.md')?.after).toContain('## 1.0.1 - ')
		const release = parseChangelog(edit('changelog.md')!.after).sections.find(
			(section) => section.version === '1.0.1',
		)
		expect(release?.body).toContain('@example/a 1.0.1')
		expect(release?.body).not.toContain('@example/b')
	})

	it('leaves an unrelated package release with the same version out of a root summary', async () => {
		const root = await createRepository({
			'packages/a/index.js': 'export const a = 1\n',
			'packages/a/package.json': '{"name":"@example/a","version":"0.1.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		await writeFiles(root, {
			'packages/a/index.js': 'export const a = 2\n',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
		})
		await commit(root, 'Release @example/a 1.0.0.')
		await git(root, ['tag', '@example/a@1.0.0'])
		const agent = fixtureAgent()
		const options = { agent, cache: false, cwd: root, github: false }
		const plan = await generateChangelog(options)
		const edit = (file: string) => plan.files.find((item) => item.path === path.join(root, file))
		expect(edit('packages/a/changelog.md')?.after).toContain('## 1.0.0 - ')
		const release = parseChangelog(edit('changelog.md')!.after).sections.find(
			(section) => section.version === '1.0.0',
		)
		expect(release?.body).toContain('Improve example in 1.0.0.')
		expect(release?.body).not.toContain('@example/a')
		await writeChangelog(plan)
		await rm(path.join(root, 'changelog.md'))
		agent.generate.mockClear()
		await generateChangelog(options)
		expect(
			agent.generate.mock.calls.flatMap(([request]) => request.releases.map(({ id }) => id)),
		).not.toContain('packages/a@1.0.0')
	})

	it('researches only the bumped release of a shared-version workspace with existing history', async () => {
		const root = await createRepository({
			'packages/a/index.js': 'export const a = 1\n',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'packages/b/package.json': '{"name":"@example/b","version":"1.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		const agent = fixtureAgent()
		await writeChangelog(await generateChangelog({ agent, cwd: root, github: false }))
		await writeFiles(root, { 'packages/a/index.js': 'export const a = 2\n' })
		await commit(root, 'Improve a.')
		await writeFiles(root, {
			'package.json': '{"engines":{"node":">=18"},"name":"example","version":"1.0.1"}',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.1"}',
			'packages/b/package.json': '{"name":"@example/b","version":"1.0.1"}',
		})
		agent.generate.mockClear()
		await generateChangelog({ agent, cwd: root, github: false })
		const researched = agent.generate.mock.calls.flatMap(([request]) =>
			request.releases.map((release) => release.version),
		)
		expect(researched).toContain('1.0.1')
		expect(researched).not.toContain('1.0.0')
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
		const summary = parseChangelog(rootFile.after).sections.find(
			(section) => section.version === '@example/b@2.0.0',
		)
		expect(undated(summary?.body)).toBe(
			'### Changed\n\n- Improve @example/b in 2.0.0.\n\n### Packages\n\n- [@example/b 2.0.0](packages/b/changelog.md#200---DATE)',
		)
		await writeChangelog(plan)
		const repeated = await generateChangelog({
			agent: fixtureAgent(),
			cwd: root,
			github: false,
		})
		expect(repeated.files).toEqual([])
	})

	it('describes a root package without changes from packages it does not depend on', async () => {
		const root = await createRepository({
			'package.json': JSON.stringify({
				dependencies: { '@example/core': 'workspace:*' },
				name: 'example',
				version: '1.0.0',
			}),
			'packages/core/index.js': 'export const core = 1\n',
			'packages/core/package.json': '{"name":"@example/core","version":"0.1.0"}',
			'packages/plugin/index.js': 'export const plugin = 1\n',
			'packages/plugin/package.json': '{"name":"@example/plugin","version":"0.1.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		await git(root, ['tag', '@example/core@0.1.0'])
		await git(root, ['tag', '@example/plugin@0.1.0'])
		await writeFiles(root, { 'packages/plugin/index.js': 'export const plugin = 2\n' })
		await commit(root, 'Improve the plugin.')
		await writeFiles(root, { 'packages/core/index.js': 'export const core = 2\n' })
		await commit(root, 'Improve the core.')
		await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
		await commit(root, 'Change the answer.')
		const agent = fixtureAgent()
		const options = { agent, cwd: root, github: false, rootChangelog: 'package' } as const
		const plan = await generateChangelog(options)
		const requests = agent.generate.mock.calls.flatMap(([request]) => request.releases)
		const unreleased = requests.find((release) => release.id === '.@Unreleased')!
		expect(unreleased.scope).toBe('package')
		expect(unreleased.repository.excludeDirectories).toEqual(['packages/plugin'])
		const messages = unreleased.evidence.map((item) => item.text).join('\n')
		expect(messages).toContain('Change the answer.')
		expect(messages).toContain('Improve the core.')
		expect(messages).not.toContain('Improve the plugin.')
		expect(requests.every((release) => release.scope === 'package')).toBe(true)
		const rootFile = plan.files.find((file) => file.path === path.join(root, 'changelog.md'))!
		expect(parseChangelog(rootFile.after).sections.map((section) => section.version)).toEqual([
			'Unreleased',
			'1.0.0',
		])
		expect(rootFile.after).not.toContain('@example/plugin')
		expect(changelogPaths(plan, root)).toEqual([
			'changelog.md',
			'packages/core/changelog.md',
			'packages/plugin/changelog.md',
		])
		await writeChangelog(plan)
		const repeated = await generateChangelog(options)
		expect(repeated.files).toEqual([])
	})

	it('leaves out the root changelog when it is set to none', async () => {
		const root = await createRepository({
			'packages/a/index.js': 'export const a = 1\n',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		const agent = fixtureAgent()
		const plan = await generateChangelog({
			agent,
			cwd: root,
			github: false,
			rootChangelog: 'none',
		})
		expect(changelogPaths(plan, root)).toEqual(['packages/a/changelog.md'])
		expect(
			agent.generate.mock.calls.flatMap(([request]) =>
				request.releases.map((release) => release.packageName),
			),
		).toEqual(['@example/a'])
	})

	it.each([
		['no workspace packages', {}, []],
		[
			'only skipped packages',
			{
				'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
				'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
			},
			['packages/*'],
		],
	])(
		'refuses to leave out the root changelog with %s',
		async (_label, files: Record<string, string>, skipPackage: string[]) => {
			const root = await createRepository(files)
			const agent = fixtureAgent()
			await expect(
				generateChangelog({ agent, cwd: root, github: false, rootChangelog: 'none', skipPackage }),
			).rejects.toThrow('no workspace packages remain')
			expect(agent.generate).not.toHaveBeenCalled()
		},
	)

	it.each([
		['shared', ['v1.0.0']],
		['independent', ['@example/a@1.0.0', '@example/internal@1.0.0']],
	])(
		'skips a package changelog with %s versions while dependents keep its changes',
		async (_label, tags) => {
			const root = await createRepository({
				'packages/a/package.json': JSON.stringify({
					dependencies: { '@example/internal': 'workspace:*' },
					name: '@example/a',
					version: '1.0.0',
				}),
				'packages/internal/index.js': 'export const internal = 1\n',
				'packages/internal/package.json': '{"name":"@example/internal","version":"1.0.0"}',
				'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
			})
			for (const tag of tags) {
				await git(root, ['tag', tag])
			}

			await writeFiles(root, { 'packages/internal/index.js': 'export const internal = 2\n' })
			await commit(root, 'Improve the internal package.')
			await writeFiles(root, { 'index.js': 'export const answer = 43\n' })
			await commit(root, 'Change the answer.')
			const agent = fixtureAgent()
			const plan = await generateChangelog({
				agent,
				cwd: root,
				github: false,
				skipPackage: ['packages/internal'],
			})
			const requests = agent.generate.mock.calls.flatMap(([request]) => request.releases)
			const evidence = (id: string) =>
				requests
					.find((release) => release.id === id)!
					.evidence.map((item) => item.text)
					.join('\n')
			expect(evidence('packages/a@Unreleased')).toContain('Improve the internal package.')
			expect(evidence('.@Unreleased')).toContain('Change the answer.')
			expect(evidence('.@Unreleased')).not.toContain('Improve the internal package.')
			expect(requests.some((release) => release.packageName === '@example/internal')).toBe(false)
			expect(changelogPaths(plan, root)).toEqual(['changelog.md', 'packages/a/changelog.md'])
			expect(
				plan.files.find((file) => file.path === path.join(root, 'changelog.md'))?.after,
			).not.toContain('@example/internal')
		},
	)

	it('names a skipPackage pattern that matches no workspace package', async () => {
		const root = await createRepository({
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		const agent = fixtureAgent()
		await expect(
			generateChangelog({
				agent,
				cwd: root,
				github: false,
				skipPackage: ['packages/a', 'packages/missing'],
			}),
		).rejects.toThrow('skipPackage pattern "packages/missing" matches no workspace package')
		expect(agent.generate).not.toHaveBeenCalled()
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

	it('links a new root summary to existing package history without researching it again', async () => {
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
		expect(parseChangelog(plan.files[0]!.after).sections[0]?.body.trim()).toBe(
			'### Packages\n\n- [@example/a 1.0.0](packages/a/changelog.md#100---2026-01-01)',
		)
		expect(await readFile(path.join(root, 'packages/a/changelog.md'), 'utf8')).toBe(history)
		expect(
			agent.generate.mock.calls.flatMap(([request]) =>
				request.releases.map(({ id, scope }) => [id, scope]),
			),
		).toEqual([['.@1.0.0', 'repository']])
	})

	it('replaces a root draft link with a summary section when an independent package is released', async () => {
		const root = await createRepository({
			'packages/a/index.js': 'export const answer = 42\n',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await git(root, ['tag', '@example/a@1.0.0'])
		const agent = fixtureAgent('Documentation')
		const options = { agent, cwd: root, github: false }
		const rootSections = (plan: Awaited<ReturnType<typeof generateChangelog>>) =>
			parseChangelog(
				plan.files.find((file) => file.path === path.join(root, 'changelog.md'))!.after,
			).sections
		await writeChangelog(await generateChangelog(options))
		await writeFiles(root, { 'packages/a/index.js': 'export const answer = 43\n' })
		await commit(root, 'Improve the package.')
		const draft = await generateChangelog(options)
		expect(rootSections(draft)[0]).toMatchObject({ version: 'Unreleased' })
		expect(rootSections(draft)[0]?.body.trim()).toBe(
			'### Packages\n\n- [@example/a Unreleased](packages/a/changelog.md#unreleased)',
		)
		const rootDraft = draft.files.find((file) => file.path === path.join(root, 'changelog.md'))!
		rootDraft.after = rootDraft.after.replace('## Unreleased\n', '## Unreleased\n\nA root note.\n')
		await writeChangelog(draft)
		await writeFiles(root, { 'packages/a/package.json': '{"name":"@example/a","version":"1.0.1"}' })
		await commit(root, 'Release: 1.0.1')
		await git(root, ['tag', '@example/a@1.0.1'])
		agent.generate.mockClear()
		const sections = rootSections(await generateChangelog(options))
		expect(sections.map((section) => section.version)).toEqual([
			'Unreleased',
			'@example/a@1.0.1',
			'@example/a@1.0.0',
		])
		expect(sections[0]?.body.trim()).toBe('A root note.')
		expect(undated(sections[1]?.body)).toBe(
			'### Documentation\n\n- Improve @example/a in 1.0.1.\n\n### Packages\n\n- [@example/a 1.0.1](packages/a/changelog.md#101---DATE)',
		)
		// The root's summary is requested apart from the package's own entry, without its commits.
		const summary = agent.generate.mock.calls
			.flatMap(([request]) => request.releases)
			.find((release) => release.id === '.@@example/a@1.0.1')
		expect(summary).toMatchObject({ packageName: '@example/a', scope: 'repository' })
		expect(summary?.repository.directory).toBe('packages/a')
		expect(summary?.evidence.map((item) => item.kind)).toEqual(['range'])
	})

	it('ends a shared-version root summary with links to the package releases it covers', async () => {
		const root = await createRepository({
			'packages/a/index.js': 'export const a = 1\n',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'packages/b/package.json': '{"name":"@example/b","version":"1.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		const agent = fixtureAgent()
		const options = { agent, cwd: root, github: false }
		const rootSection = (plan: Awaited<ReturnType<typeof generateChangelog>>) =>
			parseChangelog(
				plan.files.find((file) => file.path === path.join(root, 'changelog.md'))!.after,
			).sections[0]!
		const initial = await generateChangelog(options)
		expect(undated(rootSection(initial).body)).toBe(
			'### Changed\n\n- Improve example in 1.0.0.\n\n### Packages\n\n- [@example/a 1.0.0](packages/a/changelog.md#100---DATE)\n- [@example/b 1.0.0](packages/b/changelog.md#100---DATE)',
		)
		await writeChangelog(initial)
		await writeFiles(root, { 'packages/a/index.js': 'export const a = 2\n' })
		await commit(root, 'Improve a.')
		// A package changed, but the agent finds nothing to say about the repository as a whole.
		agent.generate.mockImplementationOnce(async (request) => {
			await Promise.resolve()
			const { releases } = describeReleases(request)
			return {
				releases: releases.map((release, index) =>
					request.releases[index]?.scope === 'repository' ? { ...release, changes: [] } : release,
				),
			}
		})
		const draft = await generateChangelog(options)
		expect(rootSection(draft).version).toBe('Unreleased')
		expect(rootSection(draft).body.trim()).toBe(
			'### Packages\n\n- [@example/a Unreleased](packages/a/changelog.md#unreleased)',
		)
		await writeChangelog(draft)
		await writeFiles(root, {
			'package.json': '{"engines":{"node":">=18"},"name":"example","version":"1.0.1"}',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.1"}',
			'packages/b/package.json': '{"name":"@example/b","version":"1.0.1"}',
		})
		const release = rootSection(await generateChangelog(options))
		expect(release.version).toBe('1.0.1')
		expect(undated(release.body)).toBe(
			'### Packages\n\n- [@example/a 1.0.1](packages/a/changelog.md#101---DATE)',
		)
	})

	it('leaves a formatted root summary alone while its package links are current', async () => {
		const root = await createRepository({
			'.gitignore': 'node_modules/\n',
			'packages/a/index.js': 'export const a = 1\n',
			'packages/a/package.json': '{"name":"@example/a","version":"1.0.0"}',
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		})
		await git(root, ['tag', 'v1.0.0'])
		await installFormatter(root, '@kitschpatrol/shared-config')
		await writeFiles(root, { 'packages/a/index.js': 'export const a = 2\n' })
		await commit(root, 'Improve a.')
		const agent = fixtureAgent()
		const options = { agent, cwd: root, github: false }
		await writeChangelog(await generateChangelog(options))
		expect(await readFile(path.join(root, 'changelog.md'), 'utf8')).toContain(
			'* [@example/a Unreleased](packages/a/changelog.md#unreleased)',
		)
		const repeated = await generateChangelog(options)
		expect(repeated.files).toEqual([])
	})
})
