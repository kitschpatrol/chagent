import type {
	AgentAdapter,
	Change,
	ChangelogPlan,
	Evidence,
	GenerateOptions,
	GenerationRequest,
	HistoryRequest,
	PackageInfo,
	Release,
	Repository,
} from './types'
import { validateChanges, validateHistory } from './agents'
import { historyBatches, researchEvidence, splitEvidence } from './batches'
import { readCache, writeCache } from './cache'
import { mergeChanges } from './changelog'
import { collectEvidence, enrichWithGithub } from './evidence'
import { instructionVersion } from './instructions'
import { log } from './log'

export type GenerationContext = {
	agent: AgentAdapter
	cacheDirectory?: string
	options: GenerateOptions
	plan: ChangelogPlan
	repository: Repository
}

export type GenerationJob = {
	changes: Change[]
	request: GenerationRequest
}

/**
 * Prepare one release without launching a model, so repository research can be
 * shared.
 */
export async function prepareGeneration(
	context: GenerationContext,
	pkg: PackageInfo,
	release: Release,
	existingEntries: string,
	mode: 'initialize' | 'update',
	from?: string,
	onlyRepositoryFiles = false,
): Promise<GenerationJob> {
	const { agent, options, repository } = context
	options.signal?.throwIfAborted()
	const excludeDirectories = onlyRepositoryFiles
		? repository.packages.map((item) => item.directory)
		: []
	const evidence = await collectEvidence(
		repository,
		pkg,
		from === undefined ? release : { ...release, previousRef: from },
		excludeDirectories,
		agent.repositoryAccess !== true,
	)
	return {
		changes: [],
		request: {
			effort: options.effort,
			evidence,
			existingEntries,
			initialRelease: release.previousRef === undefined && from === undefined,
			mode,
			model: options.model,
			packageName: pkg.name,
			repository: {
				directory: pkg.directory,
				excludeDirectories,
				from: from ?? release.previousRef,
				root: repository.root,
				to: release.ref,
			},
			scope: pkg.directory === '.' && repository.packages.length > 0 ? 'repository' : 'package',
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? 1_200_000,
			version: release.version,
		},
	}
}

function cacheKey(context: GenerationContext, request: GenerationRequest): string {
	return JSON.stringify({
		...request,
		agent: context.agent.cacheKey ?? context.agent.name,
		instructions: instructionVersion,
		maxInputChars: context.options.maxInputChars ?? 80_000,
		signal: undefined,
	})
}

async function cachedChanges(
	context: GenerationContext,
	request: GenerationRequest,
): Promise<Change[] | undefined> {
	if (context.cacheDirectory === undefined) {
		return undefined
	}

	const cached = await readCache(context.cacheDirectory, cacheKey(context, request))
	if (cached !== undefined) {
		try {
			return validateChanges(cached, request)
		} catch {
			// A changed schema or corrupt cache must not block regeneration.
		}
	}

	return undefined
}

async function saveChanges(
	context: GenerationContext,
	request: GenerationRequest,
	changes: Change[],
): Promise<void> {
	if (context.cacheDirectory !== undefined) {
		await writeCache(context.cacheDirectory, cacheKey(context, request), { changes })
	}
}

async function enrichJobs(context: GenerationContext, jobs: GenerationJob[]): Promise<void> {
	if (
		context.options.github === false ||
		context.plan.diagnostics.some((message) => message.startsWith('GitHub enrichment unavailable'))
	) {
		return
	}

	const commits = new Map<string, Evidence>()
	for (const job of jobs) {
		for (const item of job.request.evidence) {
			if (item.kind === 'commit') {
				commits.set(item.id, item)
			}
		}
	}

	const enriched = await enrichWithGithub(
		context.repository,
		commits.values().toArray(),
		context.plan.diagnostics,
		context.options.signal,
	)
	const pulls = enriched.filter((item) => item.kind === 'pull-request')
	for (const job of jobs) {
		const ids = new Set(job.request.evidence.map((item) => item.id))
		for (const pull of pulls) {
			const associated = pull.commits?.filter((commit) => ids.has(commit)) ?? []
			if (associated.length > 0) {
				job.request.evidence.push({ ...pull, commits: associated })
			}
		}
	}
}

async function generateOne(context: GenerationContext, job: GenerationJob): Promise<void> {
	const { agent, options } = context
	const limit = options.maxInputChars ?? 80_000
	const batches =
		agent.repositoryAccess === true
			? [researchEvidence(job.request.evidence, limit)]
			: splitEvidence(job.request.evidence, limit)
	log.info(
		`Summarizing ${job.request.packageName} ${job.request.version} (${batches.length} batch${batches.length === 1 ? '' : 'es'}).`,
	)
	for (const evidence of batches) {
		options.signal?.throwIfAborted()
		const request = {
			...job.request,
			evidence,
			existingEntries: mergeChanges(job.request.existingEntries, job.changes),
		}
		let changes =
			agent.repositoryAccess === true ? undefined : await cachedChanges(context, request)
		changes ??= validateChanges({ changes: await agent.generate(request) }, request)
		job.changes.push(...changes)
		if (agent.repositoryAccess !== true) {
			await saveChanges(context, request, changes)
		}
	}

	if (agent.repositoryAccess === true) {
		await saveChanges(context, job.request, job.changes)
	}
}

/**
 * Research all outstanding release ranges together before rendering any
 * changelog.
 */
export async function generateJobs(
	context: GenerationContext,
	jobs: GenerationJob[],
): Promise<void> {
	const active = jobs.filter((job) => job.request.evidence.length > 0)
	if (active.length === 0) {
		return
	}

	await enrichJobs(context, active)
	const pending: GenerationJob[] = []
	for (const job of active) {
		const cached =
			context.agent.repositoryAccess === true
				? await cachedChanges(context, job.request)
				: undefined
		if (cached === undefined) {
			pending.push(job)
		} else {
			job.changes.push(...cached)
		}
	}

	if (
		context.agent.repositoryAccess !== true ||
		context.agent.generateHistory === undefined ||
		pending.length < 2
	) {
		for (const job of pending) {
			await generateOne(context, job)
		}

		return
	}

	const batches = historyBatches(
		pending.map((job) => job.request),
		context.options.maxInputChars ?? 80_000,
	)
	log.info(
		`Researching ${pending.length} release ranges in ${batches.length} shared agent session${batches.length === 1 ? '' : 's'}.`,
	)
	for (const releases of batches) {
		context.options.signal?.throwIfAborted()
		const request: HistoryRequest = {
			effort: context.options.effort,
			model: context.options.model,
			releases,
			repositoryRoot: context.repository.root,
			signal: context.options.signal,
			timeoutMs: context.options.timeoutMs ?? 1_200_000,
		}
		const results = validateHistory(
			{ releases: await context.agent.generateHistory(request) },
			request,
		)
		for (const result of results) {
			const job = pending[Number(result.id)]!
			job.changes.push(...result.changes)
			await saveChanges(context, job.request, job.changes)
		}
	}
}
