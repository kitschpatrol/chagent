import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationContext } from '../src/lib/jobs'
import type {
	AgentAdapter,
	GenerationRequest,
	GenerationResponse,
	ReleaseRequest,
} from '../src/lib/types'
import { parseChangelog } from '../src/lib/changelog'
import { defaults } from '../src/lib/defaults'
import { generateChangelog } from '../src/lib/generate'
import { generateReleases } from '../src/lib/jobs'
import { git } from '../src/lib/process'
import { inspectRepository } from '../src/lib/repository'
import { writeChangelog } from '../src/lib/write'
import { commit, createRepository, describeReleases, writeFiles } from './helpers'

function fixtureAgent(): AgentAdapter & {
	generate: ReturnType<typeof vi.fn<AgentAdapter['generate']>>
} {
	return {
		cacheKey: 'shared-history-fixture',
		generate: vi.fn(async (request: GenerationRequest) => {
			await Promise.resolve()
			const { releases } = describeReleases(request)
			return { releases: releases.toReversed() }
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
		expect(agent.generate).toHaveBeenCalledOnce()
		const request = agent.generate.mock.calls[0]![0]
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
		expect(agent.generate).toHaveBeenCalledOnce()
		await writeChangelog(plan)
		const repeated = await generateChangelog(options)
		expect(repeated.files).toEqual([])
		await writeFiles(root, { 'readme.md': 'Install using the new instructions.\n' })
		await commit(root, 'Document installation.')
		await git(root, ['tag', 'v1.0.22'])
		const update = await generateChangelog(options)
		expect(agent.generate).toHaveBeenCalledTimes(2)
		expect(agent.generate.mock.calls[1]![0].releases).toHaveLength(1)
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
			expect(agent.generate).toHaveBeenCalledOnce()
			const request = agent.generate.mock.calls[0]![0]
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
			expect(agent.generate).toHaveBeenCalledOnce()
		},
	)

	describe.each([
		['missing', 'omitted requested releases: .@1.0.1'],
		['duplicate', 'unknown or duplicate release ids: .@1.0.0'],
		['unknown', 'unknown or duplicate release ids: not-a-release'],
		['cross-release', 'for .@1.0.0 cites evidence that was not supplied: range:'],
		['malformed', 'does not match the response format'],
	] as const)('%s release results', (invalid, expectedError) => {
		async function twoReleases(): Promise<string> {
			const root = await createRepository({ 'main.py': 'answer = 42\n' }, false)
			await git(root, ['tag', 'v1.0.0'])
			await writeFiles(root, { 'main.py': 'answer = 43\n' })
			await commit(root, 'Improve the answer.')
			await git(root, ['tag', 'v1.0.1'])
			return root
		}

		function invalidResponse(request: GenerationRequest): GenerationResponse {
			const { releases } = describeReleases(request)
			switch (invalid) {
				case 'cross-release': {
					releases[0]!.changes[0]!.sources = releases[1]!.changes[0]!.sources
					break
				}

				case 'duplicate': {
					releases.push(releases[0]!)
					break
				}

				case 'malformed': {
					return { releases: 'none' } as unknown as GenerationResponse
				}

				case 'missing': {
					releases.pop()
					break
				}

				case 'unknown': {
					releases[0]!.id = 'not-a-release'
					break
				}
			}

			return { releases }
		}

		it('gets one correction request naming the problem', async () => {
			const root = await twoReleases()
			const agent = fixtureAgent()
			agent.generate.mockImplementationOnce(async (request) => {
				await Promise.resolve()
				return invalidResponse(request)
			})
			const plan = await generateChangelog({ agent, cwd: root, github: false })
			expect(agent.generate).toHaveBeenCalledTimes(2)
			const { releases, repair } = agent.generate.mock.calls[1]![0]
			expect(repair?.error).toContain(expectedError)
			expect(repair?.response).toBeDefined()
			expect(releases).toHaveLength(2)
			expect(parseChangelog(plan.files[0]!.after).sections).toHaveLength(2)
		})

		it('stops before rendering or caching when the correction is also invalid', async () => {
			const root = await twoReleases()
			const agent = fixtureAgent()
			const invalidOnce = async (request: GenerationRequest) => {
				await Promise.resolve()
				return invalidResponse(request)
			}

			agent.generate.mockImplementationOnce(invalidOnce).mockImplementationOnce(invalidOnce)
			const options = { agent, cwd: root, github: false }
			await expect(generateChangelog(options)).rejects.toThrow(expectedError)
			expect(agent.generate).toHaveBeenCalledTimes(2)
			await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
			const retry = await generateChangelog(options)
			expect(agent.generate).toHaveBeenCalledTimes(3)
			expect(agent.generate.mock.calls[2]![0].repair).toBeUndefined()
			expect(agent.generate.mock.calls[2]![0].releases).toHaveLength(2)
			expect(retry.files).toHaveLength(1)
		})
	})

	it('reuses completed sessions after a later history session fails', async () => {
		const root = await createRepository()
		const repository = await inspectRepository(root)
		const agent = fixtureAgent()
		agent.generate
			.mockImplementationOnce(agent.generate.getMockImplementation()!)
			.mockRejectedValueOnce(new Error('Interrupted.'))
		const context: GenerationContext = {
			agent,
			cacheDirectory: path.join(repository.gitDirectory, 'chagent', 'drafts'),
			options: {
				...defaults,
				github: false,
				maxInputChars: 4000,
				rebuild: false,
				releaseDirectory: '.',
			},
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
		const requests: ReleaseRequest[] = Array.from({ length: 8 }, (_, index) => ({
			evidence: [{ id: `range:${index}`, kind: 'range', text: 'Read this release from Git.' }],
			existingEntries: 'Keep this human entry. '.repeat(40),
			id: `.@1.0.${index}`,
			initialRelease: false,
			mode: 'update',
			packageName: 'example',
			repository: { directory: '.', excludeDirectories: [], to: `release-${index}` },
			scope: 'package',
			version: `1.0.${index}`,
		}))
		await expect(generateReleases(context, requests)).rejects.toThrow('Interrupted.')
		const completed = agent.generate.mock.calls[0]![0].releases.map((release) => release.version)
		expect(completed.length).toBeGreaterThan(1)
		agent.generate.mockClear()
		const retried = await generateReleases(context, requests)
		const researched = agent.generate.mock.calls.flatMap(([request]) =>
			request.releases.map((release) => release.version),
		)
		expect(researched.toSorted()).toEqual(
			requests
				.map((request) => request.version)
				.filter((version) => !completed.includes(version))
				.toSorted(),
		)
		expect(retried.values().every((changes) => changes.length === 1)).toBe(true)
		expect(retried.size).toBe(requests.length)
	})
})
