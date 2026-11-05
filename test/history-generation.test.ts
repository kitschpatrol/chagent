import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationContext, GenerationJob } from '../src/lib/generation'
import type { AgentAdapter, Change, GenerationRequest, HistoryRequest } from '../src/lib/types'
import { parseChangelog } from '../src/lib/changelog'
import { defaults } from '../src/lib/defaults'
import { generateChangelog } from '../src/lib/generate'
import { generateJobs } from '../src/lib/generation'
import { git } from '../src/lib/process'
import { inspectRepository } from '../src/lib/repository'
import { writeChangelog } from '../src/lib/write'
import { commit, createRepository, writeFiles } from './helpers'

function change(request: Pick<GenerationRequest, 'evidence' | 'packageName' | 'version'>): Change {
	return {
		breaking: false,
		category: 'Changed',
		description: `Improve ${request.packageName} in ${request.version}.`,
		sources: [request.evidence[0]!.id],
	}
}

function fixtureAgent(): AgentAdapter & {
	generate: ReturnType<typeof vi.fn<AgentAdapter['generate']>>
	generateHistory: ReturnType<typeof vi.fn<NonNullable<AgentAdapter['generateHistory']>>>
} {
	return {
		cacheKey: 'shared-history-fixture',
		generate: vi.fn(async (request: GenerationRequest) => {
			await Promise.resolve()
			return [change(request)]
		}),
		generateHistory: vi.fn(async (request: HistoryRequest) => {
			await Promise.resolve()
			return request.releases
				.toReversed()
				.map((release) => ({ changes: [change(release)], id: release.id }))
		}),
		name: 'fixture',
	}
}

describe('shared history generation', () => {
	it('researches 22 releases once, caches them separately, and preserves them on subsequent updates', async () => {
		const root = await createRepository({ 'main.py': 'answer = 0\n' }, false)
		await git(root, ['tag', 'v1.0.0'])
		for (let index = 1; index < 22; index += 1) {
			await writeFiles(root, { 'main.py': `answer = ${index}\n` })
			await commit(root, `Improve the answer to ${index}.`)
			await git(root, ['tag', `v1.0.${index}`])
		}

		const agent = fixtureAgent()
		const options = { agent, cwd: root, github: false }
		const plan = await generateChangelog(options)
		expect(agent.generate).not.toHaveBeenCalled()
		expect(agent.generateHistory).toHaveBeenCalledOnce()
		const request = agent.generateHistory.mock.calls[0]![0]
		expect(request.releases).toHaveLength(22)
		expect(request.repositoryRoot).toBe(root)
		expect(request.releases[0]).toMatchObject({
			initialRelease: true,
			mode: 'initialize',
			version: '1.0.0',
		})
		const history = plan.files[0]!.after
		const { sections } = parseChangelog(history)
		expect(sections).toHaveLength(22)
		for (const [index, section] of sections.entries()) {
			expect(section.version).toBe(`1.0.${21 - index}`)
			expect(section.body).toContain(`in ${section.version}.`)
		}

		await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
		const cached = await generateChangelog(options)
		expect(cached.files).toEqual(plan.files)
		expect(agent.generateHistory).toHaveBeenCalledOnce()
		await writeChangelog(plan)
		const repeated = await generateChangelog(options)
		expect(repeated.files).toEqual([])
		await writeFiles(root, { 'readme.md': 'Install using the new instructions.\n' })
		await commit(root, 'Document installation.')
		await git(root, ['tag', 'v1.0.22'])
		const update = await generateChangelog(options)
		expect(agent.generate).toHaveBeenCalledOnce()
		expect(agent.generateHistory).toHaveBeenCalledOnce()
		expect(update.files[0]?.after).toContain(history.slice(history.indexOf('## ')))
		expect(update.releases.map((release) => release.version)).toEqual(['1.0.22'])
	}, 30_000)

	it.each(['shared', 'independent'] as const)(
		'shares research across packages and root in a %s monorepo',
		async (layout) => {
			const root = await createRepository(
				{
					'projects/client/client.py': 'answer = 42\n',
					'projects/engine/lib.rs': 'pub fn answer() -> u32 { 42 }\n',
					'readme.md': 'Build instructions.\n',
				},
				false,
			)
			const tags = layout === 'shared' ? ['v1.0.0'] : ['client@1.0.0', 'engine@2.0.0']
			for (const tag of tags) {
				await git(root, ['tag', tag])
			}

			await writeFiles(root, { 'readme.md': 'Improved build instructions.\n' })
			await commit(root, 'Improve repository documentation.')
			const agent = fixtureAgent()
			const options = { agent, cwd: root, github: false, packages: ['projects/*'] }
			const plan = await generateChangelog(options)
			expect(agent.generate).not.toHaveBeenCalled()
			expect(agent.generateHistory).toHaveBeenCalledOnce()
			const request = agent.generateHistory.mock.calls[0]![0]
			expect(new Set(request.releases.map((release) => release.repository.directory))).toEqual(
				new Set(['.', 'projects/client', 'projects/engine']),
			)
			expect(
				request.releases.find(
					(release) => release.repository.directory === '.' && release.version === 'Unreleased',
				)?.scope,
			).toBe('repository')
			expect(plan.files).toHaveLength(3)
			const rootFile = plan.files.find((file) => file.path === path.join(root, 'changelog.md'))!
			expect(rootFile.after).toContain('projects/client/changelog.md#100--')
			expect(rootFile.after).toContain(layout === 'shared' ? '## 1.0.0 - ' : '## engine@2.0.0 - ')
			expect(rootFile.after).toContain('## Unreleased')
			await writeChangelog(plan)
			const repeated = await generateChangelog(options)
			expect(repeated.files).toEqual([])
			expect(agent.generateHistory).toHaveBeenCalledOnce()
		},
	)

	it.each(['missing', 'duplicate', 'unknown', 'cross-release'] as const)(
		'rejects %s release results before rendering or caching',
		async (invalid) => {
			const root = await createRepository({ 'main.py': 'answer = 42\n' }, false)
			await git(root, ['tag', 'v1.0.0'])
			await writeFiles(root, { 'main.py': 'answer = 43\n' })
			await commit(root, 'Improve the answer.')
			await git(root, ['tag', 'v1.0.1'])
			const agent = fixtureAgent()
			agent.generateHistory.mockImplementationOnce(async (request) => {
				await Promise.resolve()
				const results = request.releases.map((release) => ({
					changes: [change(release)],
					id: release.id,
				}))
				switch (invalid) {
					case 'cross-release': {
						results[0]!.changes[0]!.sources = results[1]!.changes[0]!.sources

						break
					}

					case 'duplicate': {
						results.push(results[0]!)

						break
					}

					case 'missing': {
						results.pop()

						break
					}

					case 'unknown': {
						results[0]!.id = 'not-a-release'

						break
					}
				}

				return results
			})
			const options = { agent, cwd: root, github: false }
			await expect(generateChangelog(options)).rejects.toThrow()
			await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
			const retry = await generateChangelog(options)
			expect(agent.generateHistory).toHaveBeenCalledTimes(2)
			expect(agent.generateHistory.mock.calls[1]![0].releases).toHaveLength(2)
			expect(retry.files).toHaveLength(1)
		},
	)

	it('reuses completed sessions after a later history session fails', async () => {
		const root = await createRepository()
		const repository = await inspectRepository(root)
		const agent = fixtureAgent()
		agent.generateHistory
			.mockImplementationOnce(agent.generateHistory.getMockImplementation()!)
			.mockRejectedValueOnce(new Error('Interrupted.'))
		const context: GenerationContext = {
			agent,
			cacheDirectory: path.join(repository.gitDirectory, 'chagent', 'drafts'),
			options: { ...defaults, github: false, maxInputChars: 4000, rebuild: false },
			plan: {
				checkpoints: [],
				diagnostics: [],
				files: [],
				head: repository.head,
				releases: [],
				root,
			},
			repository,
		}
		const requests: GenerationRequest[] = Array.from({ length: 8 }, (_, index) => ({
			evidence: [{ id: `range:${index}`, kind: 'range', text: 'Read this release from Git.' }],
			existingEntries: 'Keep this human entry. '.repeat(40),
			packageName: 'example',
			repository: { directory: '.', excludeDirectories: [], root, to: `release-${index}` },
			timeoutMs: 5000,
			version: `1.0.${index}`,
		}))
		const jobs = (): GenerationJob[] => requests.map((request) => ({ changes: [], request }))
		await expect(generateJobs(context, jobs())).rejects.toThrow('Interrupted.')
		const completed = agent.generateHistory.mock.calls[0]![0].releases.map(
			(release) => release.version,
		)
		expect(completed.length).toBeGreaterThan(1)
		agent.generateHistory.mockClear()
		const retried = jobs()
		await generateJobs(context, retried)
		const researched = agent.generateHistory.mock.calls.flatMap(([request]) =>
			request.releases.map((release) => release.version),
		)
		expect(researched.toSorted()).toEqual(
			requests
				.map((request) => request.version)
				.filter((version) => !completed.includes(version))
				.toSorted(),
		)
		expect(retried.every((job) => job.changes.length === 1)).toBe(true)
		expect(agent.generate).not.toHaveBeenCalled()
	})
})
