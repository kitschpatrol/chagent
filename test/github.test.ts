import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { GenerationJob } from '../src/lib/generation'
import type * as processModule from '../src/lib/process'
import type { AgentAdapter, Evidence, HistoryRequest, Repository } from '../src/lib/types'
import { defaults } from '../src/lib/defaults'
import { enrichWithGithub } from '../src/lib/evidence'
import { generateChangelog } from '../src/lib/generate'
import { generateJobs } from '../src/lib/generation'
import { git, runCommand } from '../src/lib/process'
import { createRepository } from './helpers'

vi.mock('../src/lib/process', async (importOriginal) => ({
	...(await importOriginal<typeof processModule>()),
	runCommand: vi.fn(),
}))

const repository: Repository = {
	gitDirectory: '/example/.git',
	github: 'owner/example',
	head: 'head',
	packages: [],
	root: '/example',
	rootPackage: { directory: '.', name: 'example' },
	tags: [],
}

function commit(id: string): Evidence {
	return { id, kind: 'commit', text: `Improve ${id}.` }
}

function connection(number: number, cursor?: string) {
	return {
		associatedPullRequests: {
			nodes: [
				{
					body: 'Implementation details.',
					mergedAt: '2026-01-01',
					number,
					title: 'Improve behavior.',
					url: `https://github.com/owner/example/pull/${number}`,
				},
			],
			pageInfo: { endCursor: cursor ?? 'end', hasNextPage: cursor !== undefined },
		},
	}
}

function response(entries: Record<string, ReturnType<typeof connection>>) {
	return { code: 0, stderr: '', stdout: JSON.stringify({ data: { repository: entries } }) }
}

function queries(): string[] {
	return vi
		.mocked(runCommand)
		.mock.calls.map(
			(call) => z.object({ query: z.string() }).parse(JSON.parse(call[2]!.input!)).query,
		)
}

beforeEach(() => {
	vi.mocked(runCommand).mockReset()
})

describe('batched GitHub enrichment', () => {
	it('looks up unique commits in batches and retains every association for a shared PR', async () => {
		const commits = Array.from({ length: 26 }, (_, index) => commit(`commit-${index}`))
		vi.mocked(runCommand)
			.mockResolvedValueOnce(
				response(
					Object.fromEntries(commits.slice(0, 25).map((_, index) => [`c${index}`, connection(42)])),
				),
			)
			.mockResolvedValueOnce(response({ c0: connection(42) }))
		const diagnostics: string[] = []
		const result = await enrichWithGithub(repository, [...commits, commits[0]!], diagnostics)
		expect(runCommand).toHaveBeenCalledTimes(2)
		expect(queries()[0]?.match(/object\(oid:/gv)).toHaveLength(25)
		expect(queries()[1]?.match(/object\(oid:/gv)).toHaveLength(1)
		expect(queries().some((query) => query.includes('releases'))).toBe(false)
		const pulls = result.filter((item) => item.kind === 'pull-request')
		expect(pulls).toHaveLength(1)
		expect(pulls[0]?.commits).toEqual(commits.map((item) => item.id))
		expect(diagnostics).toEqual([])
	})

	it('skips local commits and unmerged PRs without losing merged PRs', async () => {
		vi.mocked(runCommand).mockResolvedValue({
			code: 0,
			stderr: '',
			stdout: `{"data":{"repository":{
			"c0":null,
			"c1":{"associatedPullRequests":{"nodes":[null,{"number":1,"title":"Open","body":"","url":"https://github.com/owner/example/pull/1","mergedAt":null}],"pageInfo":{"hasNextPage":false,"endCursor":null}}},
			"c2":${JSON.stringify(connection(2))}
		}}}`,
		})
		const diagnostics: string[] = []
		const result = await enrichWithGithub(
			repository,
			[commit('local'), commit('open'), commit('merged')],
			diagnostics,
		)
		expect(result.filter((item) => item.kind === 'pull-request').map((item) => item.id)).toEqual([
			'pr:2',
		])
		expect(diagnostics).toEqual([])
	})

	it('follows association pagination without repeating completed commits', async () => {
		vi.mocked(runCommand)
			.mockResolvedValueOnce(response({ c0: connection(1, 'next'), c1: connection(2) }))
			.mockResolvedValueOnce(response({ c0: connection(3) }))
		const result = await enrichWithGithub(repository, [commit('first'), commit('second')], [])
		expect(result.filter((item) => item.kind === 'pull-request').map((item) => item.id)).toEqual([
			'pr:1',
			'pr:2',
			'pr:3',
		])
		expect(queries()[1]).toContain('after: "next"')
		expect(queries()[1]).not.toContain('second')
	})

	it('falls back to Git when GitHub is unavailable and propagates cancellation', async () => {
		vi.mocked(runCommand).mockRejectedValue(new Error('GitHub is unavailable.'))
		const evidence = [commit('first')]
		const diagnostics: string[] = []
		expect(await enrichWithGithub(repository, evidence, diagnostics)).toEqual(evidence)
		expect(diagnostics[0]).toContain('using Git evidence')
		const controller = new AbortController()
		controller.abort()
		await expect(
			enrichWithGithub(repository, evidence, diagnostics, controller.signal),
		).rejects.toThrow()
		expect(runCommand).toHaveBeenCalledOnce()
	})

	it('skips PR lookups once release dates show GitHub is unavailable', async () => {
		vi.mocked(runCommand).mockRejectedValue(new Error('GitHub is unavailable.'))
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await git(root, ['remote', 'add', 'origin', 'https://github.com/owner/example.git'])
		const plan = await generateChangelog({
			agent: {
				async generate(request) {
					await Promise.resolve()
					return [
						{
							breaking: false,
							category: 'Added',
							description: 'Add a feature.',
							sources: [request.evidence[0]!.id],
						},
					]
				},
				name: 'fixture',
			},
			cwd: root,
		})
		expect(runCommand).toHaveBeenCalledOnce()
		expect(plan.diagnostics).toHaveLength(1)
		expect(plan.diagnostics[0]).toContain('using Git evidence')
	})

	it('deduplicates lookups across releases and scopes PR evidence to associated commits', async () => {
		vi.mocked(runCommand).mockResolvedValue(response({ c0: connection(1), c1: connection(2) }))
		const generateHistory = vi.fn(async (request: HistoryRequest) => {
			await Promise.resolve()
			return request.releases.map((release) => ({ changes: [], id: release.id }))
		})
		const agent: AgentAdapter = {
			generate: vi.fn(),
			generateHistory,
			name: 'fixture',
			repositoryAccess: true,
		}
		const jobs: GenerationJob[] = ['first', 'second', 'first'].map((id, index) => ({
			changes: [],
			request: {
				evidence: [commit(id)],
				existingEntries: '',
				packageName: `package-${index}`,
				timeoutMs: 5000,
				version: '1.0.0',
			},
		}))
		await generateJobs(
			{
				agent,
				options: { ...defaults, cache: false, rebuild: false },
				plan: {
					checkpoints: [],
					diagnostics: [],
					files: [],
					head: 'head',
					releases: [],
					root: repository.root,
				},
				repository,
			},
			jobs,
		)
		expect(runCommand).toHaveBeenCalledOnce()
		expect(queries()[0]?.match(/object\(oid:/gv)).toHaveLength(2)
		expect(generateHistory).toHaveBeenCalledOnce()
		const { releases } = generateHistory.mock.calls[0]![0]
		expect(
			releases.map((release) =>
				release.evidence.filter((item) => item.kind === 'pull-request').map((item) => item.id),
			),
		).toEqual([['pr:1'], ['pr:2'], ['pr:1']])
	})
})
