import type {
	AgentAdapter,
	Change,
	ChangelogPlan,
	Evidence,
	PackageInfo,
	Release,
	ReleaseRequest,
	Repository,
	ResolvedOptions,
} from './types'
import { validateResponse } from './agents'
import { releaseBatches } from './batches'
import { readCache, writeCache } from './cache'
import { collectEvidence, enrichWithGithub } from './evidence'
import { instructionVersion } from './instructions'
import { log } from './log'

export type GenerationContext = {
	agent: AgentAdapter
	cacheDirectory?: string
	options: ResolvedOptions
	plan: ChangelogPlan
	repository: Repository
}

export type GenerationJob = {
	changes: Change[]
	request: ReleaseRequest
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
	const { options, repository } = context
	options.signal?.throwIfAborted()
	const excludeDirectories = onlyRepositoryFiles
		? repository.packages.map((item) => item.directory)
		: []
	const evidence = await collectEvidence(
		repository,
		pkg,
		from === undefined ? release : { ...release, previousRef: from },
		excludeDirectories,
	)
	return {
		changes: [],
		request: {
			evidence,
			existingEntries,
			id: `${pkg.directory}@${release.version}`,
			initialRelease: release.previousRef === undefined && from === undefined,
			mode,
			packageName: pkg.name,
			repository: {
				directory: pkg.directory,
				excludeDirectories,
				from: from ?? release.previousRef,
				to: release.ref,
			},
			scope: pkg.directory === '.' && repository.packages.length > 0 ? 'repository' : 'package',
			version: release.version,
		},
	}
}

function cacheKey(context: GenerationContext, release: ReleaseRequest): string {
	const { effort, maxInputChars, model } = context.options
	return JSON.stringify({
		agent: context.agent.cacheKey,
		effort,
		instructions: instructionVersion,
		maxInputChars,
		model,
		release,
	})
}

async function cachedChanges(
	context: GenerationContext,
	release: ReleaseRequest,
): Promise<Change[] | undefined> {
	if (context.cacheDirectory === undefined) {
		return undefined
	}

	const cached = await readCache(context.cacheDirectory, cacheKey(context, release))
	if (cached !== undefined) {
		try {
			return validateResponse({ releases: [cached] }, [release])[0]!.changes
		} catch {
			// A changed schema or corrupt cache must not block regeneration.
		}
	}

	return undefined
}

async function saveChanges(
	context: GenerationContext,
	release: ReleaseRequest,
	changes: Change[],
): Promise<void> {
	if (context.cacheDirectory !== undefined) {
		await writeCache(context.cacheDirectory, cacheKey(context, release), {
			changes,
			id: release.id,
		})
	}
}

async function enrichJobs(context: GenerationContext, jobs: GenerationJob[]): Promise<void> {
	if (!context.options.github) {
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

function progressMessage(pending: GenerationJob[], sessions: number): string {
	const [only] = pending
	if (only !== undefined && pending.length === 1) {
		return `Researching ${only.request.packageName} ${only.request.version}.`
	}

	return `Researching ${pending.length} release ranges in ${sessions} shared agent session${sessions === 1 ? '' : 's'}.`
}

/**
 * Research all outstanding release ranges together before rendering any
 * changelog.
 */
export async function generateJobs(
	context: GenerationContext,
	jobs: GenerationJob[],
): Promise<void> {
	const { agent, options, repository } = context
	const active = jobs.filter((job) => job.request.evidence.length > 0)
	if (active.length === 0) {
		return
	}

	await enrichJobs(context, active)
	const pending = new Map<string, GenerationJob>()
	for (const job of active) {
		const cached = await cachedChanges(context, job.request)
		if (cached === undefined) {
			pending.set(job.request.id, job)
		} else {
			job.changes.push(...cached)
		}
	}

	if (pending.size === 0) {
		return
	}

	const remaining = pending.values().toArray()
	const batches = releaseBatches(
		remaining.map((job) => job.request),
		options.maxInputChars,
	)
	log.info(progressMessage(remaining, batches.length))
	for (const releases of batches) {
		options.signal?.throwIfAborted()
		const response = await agent.generate({
			releases,
			repositoryRoot: repository.root,
			settings: {
				effort: options.effort,
				model: options.model,
				signal: options.signal,
				timeoutMs: options.timeoutMs,
			},
		})
		for (const { changes, id } of validateResponse(response, releases)) {
			const job = pending.get(id)!
			job.changes.push(...changes)
			await saveChanges(context, job.request, job.changes)
		}
	}
}
