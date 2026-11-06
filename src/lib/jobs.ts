import type {
	AgentAdapter,
	Change,
	ChangelogPlan,
	ChangeSet,
	Evidence,
	GenerationRequest,
	PackageInfo,
	Release,
	ReleaseRequest,
	Repository,
	ResolvedOptions,
} from './types'
import { validateResponse } from './agents'
import { releaseBatches } from './batches'
import { readCache, writeCache } from './cache'
import { collectEvidence, enrichWithGithub, packageScope } from './evidence'
import { instructionVersion } from './instructions'
import { log } from './log'

export type GenerationContext = {
	agent: AgentAdapter
	cacheDirectory?: string
	options: ResolvedOptions
	plan: ChangelogPlan
	repository: Repository
}

/**
 * Prepare one release without launching a model, so repository research can be
 * shared.
 */
export async function prepareRelease(
	context: GenerationContext,
	pkg: PackageInfo,
	release: Release,
	existingEntries: string,
	mode: 'initialize' | 'update',
	from?: string,
	onlyRepositoryFiles = false,
): Promise<ReleaseRequest> {
	const { options, repository } = context
	options.signal?.throwIfAborted()
	const excludeDirectories = await excludedPackages(context, pkg, release.ref, onlyRepositoryFiles)
	const evidence = await collectEvidence(
		repository,
		pkg,
		from === undefined ? release : { ...release, previousRef: from },
		excludeDirectories,
	)
	return {
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
		scope:
			pkg.directory === '.' && repository.packages.length > 0 && options.rootChangelog === 'summary'
				? 'repository'
				: 'package',
		version: release.version,
	}
}

/**
 * Select the package directories a release leaves out: every package when
 * describing repository files alone, skipped packages in a whole-repository
 * summary, or, when the root is a package itself, those it does not depend on.
 */
async function excludedPackages(
	context: GenerationContext,
	pkg: PackageInfo,
	ref: string,
	onlyRepositoryFiles: boolean,
): Promise<string[]> {
	const { options, repository } = context
	const directories = repository.packages.map((item) => item.directory)
	if (onlyRepositoryFiles || directories.length === 0) {
		return directories
	}

	if (pkg.directory !== '.') {
		return []
	}

	if (options.rootChangelog === 'summary') {
		return repository.packages.filter((item) => item.skipped === true).map((item) => item.directory)
	}

	const scope = new Set(await packageScope(repository, pkg, ref))
	return directories.filter((directory) => !scope.has(directory))
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

async function withPullRequests(
	context: GenerationContext,
	releases: ReleaseRequest[],
): Promise<ReleaseRequest[]> {
	if (!context.options.github) {
		return releases
	}

	const commits = new Map<string, Evidence>()
	for (const release of releases) {
		for (const item of release.evidence) {
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
	return releases.map((release) => {
		const ids = new Set(release.evidence.map((item) => item.id))
		const associated = pulls
			.map((pull) => ({
				...pull,
				commits: pull.commits?.filter((commit) => ids.has(commit)) ?? [],
			}))
			.filter((pull) => pull.commits.length > 0)
		return { ...release, evidence: [...release.evidence, ...associated] }
	})
}

function progressMessage(pending: ReleaseRequest[], sessions: number): string {
	const [only] = pending
	if (only !== undefined && pending.length === 1) {
		return `Researching ${only.packageName} ${only.version}.`
	}

	return `Researching ${pending.length} release ranges in ${sessions} shared agent session${sessions === 1 ? '' : 's'}.`
}

/**
 * Run one agent session. A long session is worth saving, so invalid output gets
 * one correction request before the run fails.
 */
async function runSession(
	context: GenerationContext,
	releases: ReleaseRequest[],
): Promise<ChangeSet[]> {
	const { agent, options, repository } = context
	const request: GenerationRequest = {
		releases,
		repositoryRoot: repository.root,
		settings: {
			effort: options.effort,
			model: options.model,
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		},
	}
	log.debug(
		`Starting a ${agent.name} session for ${releases.map(({ id }) => id).join(', ')} with model ${options.model ?? 'default'}, effort ${options.effort}, and a ${options.timeoutMs} ms timeout.`,
	)
	const started = performance.now()
	const response = await agent.generate(request)
	log.debug(`The ${agent.name} session finished in ${Math.round(performance.now() - started)} ms.`)
	try {
		return validateResponse(response, releases)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		log.warn(`Requesting a correction of invalid agent output. ${message}`)
		options.onProgress?.('Requesting a correction of invalid agent output.')
		options.signal?.throwIfAborted()
		const corrected = await agent.generate({ ...request, repair: { error: message, response } })
		return validateResponse(corrected, releases)
	}
}

/**
 * Research all outstanding release ranges together before rendering any
 * changelog.
 *
 * @returns Changes keyed by release ID. Releases without evidence are absent.
 */
export async function generateReleases(
	context: GenerationContext,
	requests: ReleaseRequest[],
): Promise<Map<string, Change[]>> {
	const { options } = context
	const results = new Map<string, Change[]>()
	const active = requests.filter((release) => release.evidence.length > 0)
	for (const release of requests) {
		log.debug(
			`${release.id}: ${release.evidence.length} evidence items, range ${release.repository.from ?? 'start of history'}..${release.repository.to}.`,
		)
	}

	if (active.length === 0) {
		return results
	}

	const enriched = await withPullRequests(context, active)
	const pending: ReleaseRequest[] = []
	for (const release of enriched) {
		const cached = await cachedChanges(context, release)
		if (cached === undefined) {
			pending.push(release)
		} else {
			log.debug(`Using the cached draft for ${release.id}.`)
			results.set(release.id, cached)
		}
	}

	if (pending.length === 0) {
		return results
	}

	const unabridged = new Map(pending.map((release) => [release.id, release]))
	const batches = releaseBatches(pending, options.maxInputChars)
	const status = progressMessage(pending, batches.length)
	log.info(status)
	options.onProgress?.(status)
	for (const releases of batches) {
		options.signal?.throwIfAborted()
		const changeSets = await runSession(context, releases)
		for (const { changes, id } of changeSets) {
			results.set(id, changes)
			await saveChanges(context, unabridged.get(id)!, changes)
		}
	}

	return results
}
