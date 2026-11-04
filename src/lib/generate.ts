import path from 'node:path'
import semver from 'semver'
import { z } from 'zod'
import type {
	AgentAdapter,
	Change,
	ChangelogPlan,
	Evidence,
	GenerateOptions,
	GenerationRequest,
	PackageInfo,
	Release,
	ReleaseSummary,
	Repository,
} from './types'
import { createAgent, validateChanges } from './agents'
import { hash, readCache, writeCache } from './cache'
import { findChangelog, mergeChanges, parseChangelog, updateMarkdown } from './changelog'
import { loadConfig } from './config'
import { collectEvidence, enrichReleaseDates, enrichWithGithub } from './evidence'
import { instructionVersion } from './instructions'
import { log } from './log'
import { git, runCommand } from './process'
import { hasNodeException, inspectRepository, resolveReleases } from './repository'

const checkpointSchema = z.object({
	baseRef: z.string(),
	contentHash: z.string(),
	head: z.string(),
	path: z.string(),
})
type Context = {
	agent: AgentAdapter
	cacheDirectory?: string
	options: GenerateOptions
	plan: ChangelogPlan
	repository: Repository
}

function splitEvidence(evidence: Evidence[], limit: number): Evidence[][] {
	const batches: Evidence[][] = []
	let batch: Evidence[] = []
	let size = 0
	for (const item of evidence) {
		const chunkSize = Math.floor(limit / 8)
		for (let offset = 0; offset < Math.max(item.text.length, 1); offset += chunkSize) {
			const part = {
				...item,
				id: item.text.length > chunkSize ? `${item.id}#${offset}` : item.id,
				text: item.text.slice(offset, offset + chunkSize),
			}
			const { length } = JSON.stringify(part)
			if (size + length > limit && batch.length > 0) {
				batches.push(batch)
				batch = []
				size = 0
			}

			batch.push(part)
			size += length
		}
	}

	if (batch.length > 0) {
		batches.push(batch)
	}

	return batches
}

async function summarize(
	context: Context,
	pkg: PackageInfo,
	release: Release,
	existingEntries: string,
	from?: string,
	onlyRepositoryFiles = false,
): Promise<Change[]> {
	const { agent, options, plan, repository } = context
	let evidence = await collectEvidence(
		repository,
		pkg,
		from === undefined ? release : { ...release, previousRef: from },
		onlyRepositoryFiles ? repository.packages.map((item) => item.directory) : [],
	)
	if (evidence.length === 0) {
		return []
	}

	if (
		options.github !== false &&
		plan.diagnostics.every((message) => !message.startsWith('GitHub enrichment unavailable'))
	) {
		evidence = await enrichWithGithub(repository, evidence, plan.diagnostics, options.signal)
	}

	const changes: Change[] = []
	const batches = splitEvidence(evidence, options.maxInputChars ?? 80_000)
	log.info(
		`Summarizing ${pkg.name} ${release.version} (${batches.length} batch${batches.length === 1 ? '' : 'es'}).`,
	)
	for (const batch of batches) {
		options.signal?.throwIfAborted()
		const request: GenerationRequest = {
			effort: options.effort,
			evidence: batch,
			existingEntries: mergeChanges(existingEntries, changes),
			model: options.model,
			packageName: pkg.name,
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? 1_200_000,
			version: release.version,
		}
		const key = JSON.stringify({
			...request,
			agent: agent.cacheKey ?? agent.name,
			instructions: instructionVersion,
			signal: undefined,
		})
		const cached =
			context.cacheDirectory === undefined
				? undefined
				: await readCache(context.cacheDirectory, key)
		let generated: Change[] | undefined
		if (cached !== undefined) {
			try {
				generated = validateChanges(cached, request)
			} catch {
				// A changed schema or corrupt cache must not block regeneration.
			}
		}

		generated ??= validateChanges({ changes: await agent.generate(request) }, request)
		changes.push(...generated)
		if (context.cacheDirectory !== undefined) {
			await writeCache(context.cacheDirectory, key, { changes: generated })
		}
	}

	return changes
}

async function incrementalBase(
	context: Context,
	file: string,
	content: string | undefined,
	release: Release,
): Promise<string | undefined> {
	if (content === undefined || context.options.cache === false) {
		return undefined
	}

	const result = checkpointSchema.safeParse(
		await readCache(path.join(context.repository.gitDirectory, 'chagent', 'checkpoints'), file),
	)
	if (
		!result.success ||
		result.data.contentHash !== hash(content) ||
		result.data.baseRef !== (release.previousRef ?? 'initial')
	) {
		return undefined
	}

	const ancestor = await runCommand(
		'git',
		['merge-base', '--is-ancestor', result.data.head, release.ref],
		{ allowFailure: true, cwd: context.repository.root },
	)
	return ancestor.code === 0 ? result.data.head : undefined
}

function missingReleases(releases: Release[], content = ''): Release[] {
	const { sections } = parseChangelog(content)
	const known = new Set(sections.map((section) => section.version))
	const recorded = sections
		.filter((section) => section.version !== 'Unreleased')
		.map((section) => section.version)
	if (recorded.some((version) => semver.valid(version) === null)) {
		throw new Error(
			'The existing changelog has unrecognized release headings. Normalize its release headings before updating it.',
		)
	}

	const newest = recorded.toSorted(semver.rcompare)[0]
	if (newest !== undefined && releases.every((release) => release.version !== newest)) {
		throw new Error(
			`Cannot locate the Git release boundary for existing changelog version ${newest}. Fetch its tags or configure tagPatterns.`,
		)
	}

	return releases.filter(
		(release) =>
			release.version === 'Unreleased' ||
			(!known.has(release.version) && (newest === undefined || semver.gt(release.version, newest))),
	)
}

async function generatePackage(
	context: Context,
	pkg: PackageInfo,
	aggregateHistory = false,
): Promise<{ exception: boolean; releases: Release[]; summaries: ReleaseSummary[] }> {
	const { plan, repository } = context
	const file = await findChangelog(path.join(repository.root, pkg.directory))
	const releases = await resolveReleases(repository, pkg, context.options, context.options.release)
	const missing = missingReleases(releases, file.content)
	const parsed = parseChangelog(file.content ?? '')
	const draft = parsed.sections.find((section) => section.version === 'Unreleased')
	const newest = releases.findLast((release) => release.version !== 'Unreleased')
	const entries: Parameters<typeof updateMarkdown>[1] = []
	const summaries: ReleaseSummary[] = []
	for (const release of releases) {
		const shouldWrite = missing.includes(release)
		if (!shouldWrite && !aggregateHistory) {
			continue
		}

		const promotesDraft = release === newest && shouldWrite && draft !== undefined
		const existingBody = promotesDraft || release.version === 'Unreleased' ? draft?.body : undefined
		const from =
			existingBody === undefined
				? undefined
				: await incrementalBase(context, file.path, file.content, release)
		const changes = await summarize(context, pkg, release, existingBody ?? '', from)
		summaries.push({
			changelogPath: file.path,
			changes,
			date: release.date,
			packageDirectory: pkg.directory,
			packageName: pkg.name,
			ref: release.ref,
			tag: release.tag,
			version: release.version,
		})
		if (shouldWrite && (release.version !== 'Unreleased' || changes.length > 0)) {
			entries.push({ changes, existingBody, release })
		}
	}

	const exception = await hasNodeException(repository, pkg, releases)
	const after = updateMarkdown(file.content, entries, exception, repository.github)
	if (after !== file.content) {
		plan.files.push({ after, before: file.content, path: file.path })
	}

	const current = releases.at(-1)
	if (current !== undefined && context.options.cache !== false) {
		plan.checkpoints.push({
			baseRef: current.previousRef ?? 'initial',
			contentHash: hash(after),
			head: repository.head,
			path: file.path,
		})
	}

	return { exception, releases, summaries }
}

function packageLink(repository: Repository, summary: ReleaseSummary): string {
	const relative = path.relative(repository.root, summary.changelogPath).split(path.sep).join('/')
	const anchor =
		summary.version === 'Unreleased'
			? 'unreleased'
			: `${summary.version.replaceAll('.', '')}${summary.date === undefined ? '' : '--' + summary.date}`
	return repository.github === undefined
		? `${relative}#${anchor}`
		: `https://github.com/${repository.github}/blob/HEAD/${relative}#${anchor}`
}

function aggregateChanges(repository: Repository, summaries: ReleaseSummary[]): Change[] {
	const changes: Change[] = []
	for (const summary of summaries) {
		if (summary.version === 'Unreleased' && summary.changes.length === 0) {
			continue
		}

		const link = `[${summary.packageName} ${summary.version}](${packageLink(repository, summary)})`
		const highlights = summary.changes.slice(0, 3)
		if (highlights.length === 0) {
			changes.push({
				breaking: false,
				category: 'Changed',
				description: `${link}: See the package changelog.`,
				sources: [],
			})
		} else {
			for (const change of highlights) {
				changes.push({ ...change, description: `${link}: ${change.description}` })
			}
		}
	}

	return changes
}

async function aggregateIndependent(
	context: Context,
	summaries: ReleaseSummary[],
	exception: boolean,
): Promise<void> {
	const { plan, repository } = context
	const file = await findChangelog(repository.root)
	const parsed = parseChangelog(file.content ?? '')
	const known = new Set(parsed.sections.map((section) => section.version))
	const entries: Parameters<typeof updateMarkdown>[1] = []
	const ordered = summaries.toSorted((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))
	for (const summary of ordered) {
		if (summary.version === 'Unreleased') {
			continue
		}

		const label = `${summary.packageName}@${summary.version}`
		if (known.has(label)) {
			continue
		}

		const versions = parsed.sections
			.map((section) =>
				section.version.startsWith(summary.packageName + '@')
					? section.version.slice(summary.packageName.length + 1)
					: '',
			)
			.filter((version) => semver.valid(version) !== null)
		if (versions.some((version) => semver.gte(version, summary.version))) {
			continue
		}

		entries.push({
			changes: aggregateChanges(repository, [summary]),
			release: { date: summary.date, ref: summary.ref, tag: summary.tag, version: label },
		})
	}

	const unreleased = aggregateChanges(
		repository,
		summaries.filter((summary) => summary.version === 'Unreleased'),
	)
	const releaseRefs = new Set(
		summaries.filter((summary) => summary.version !== 'Unreleased').map((summary) => summary.ref),
	)
	const ancestors = await git(repository.root, ['rev-list', '--topo-order', repository.head])
	const base = ancestors.split('\n').find((ref) => releaseRefs.has(ref))
	const draftRelease: Release = { previousRef: base, ref: repository.head, version: 'Unreleased' }
	const draft = parsed.sections.find((section) => section.version === 'Unreleased')?.body
	const from = await incrementalBase(context, file.path, file.content, draftRelease)
	unreleased.push(
		...(await summarize(context, repository.rootPackage, draftRelease, draft ?? '', from, true)),
	)
	if (unreleased.length > 0) {
		entries.push({
			changes: unreleased,
			existingBody: parsed.sections.find((section) => section.version === 'Unreleased')?.body,
			release: { ref: repository.head, version: 'Unreleased' },
		})
	}

	const after = updateMarkdown(file.content, entries, exception, repository.github)
	if (after !== file.content) {
		plan.files.push({ after, before: file.content, path: file.path })
	}

	if (context.options.cache !== false) {
		plan.checkpoints.push({
			baseRef: base ?? 'initial',
			contentHash: hash(after),
			head: repository.head,
			path: file.path,
		})
	}
}

/** Generate reviewable edits from Git history without changing tracked files. */
export async function generateChangelog(options: GenerateOptions = {}): Promise<ChangelogPlan> {
	const root = await git(options.cwd ?? process.cwd(), ['rev-parse', '--show-toplevel'])
	const config = await loadConfig(root, options.configFile)
	const selected = Object.fromEntries(
		Object.entries(options as Record<string, unknown>).filter(([, value]) => value !== undefined),
	) as GenerateOptions
	const resolved = { ...config, ...selected }
	validateLimits(resolved)

	const repository = await inspectRepository(root, resolved)
	const agent =
		typeof resolved.agent === 'object' ? resolved.agent : createAgent(resolved.agent ?? 'codex')
	const plan: ChangelogPlan = {
		checkpoints: [],
		diagnostics: [],
		files: [],
		head: repository.head,
		releases: [],
		root,
	}
	if (resolved.github !== false) {
		await enrichReleaseDates(repository, plan.diagnostics, resolved.signal)
	}

	const context: Context = {
		agent,
		cacheDirectory:
			resolved.cache === false || agent.cacheKey === undefined
				? undefined
				: path.join(repository.gitDirectory, 'chagent', 'drafts'),
		options: resolved,
		plan,
		repository,
	}
	if (repository.packages.length === 0) {
		const result = await generatePackage(context, repository.rootPackage)
		plan.releases.push(...result.summaries)
	} else {
		const rootReleases = await resolveReleases(
			repository,
			repository.rootPackage,
			resolved,
			resolved.release,
		)
		const shared = rootReleases.some((release) => release.version !== 'Unreleased')
		let exception = false
		for (const pkg of repository.packages) {
			const result = await generatePackage(context, pkg, !shared)
			exception ||= result.exception
			plan.releases.push(...result.summaries)
		}

		if (shared) {
			const result = await generatePackage(context, repository.rootPackage)
			const rootEdit = plan.files.find((file) => path.dirname(file.path) === root)
			if (rootEdit) {
				const additions = result.summaries.map((summary) => {
					const packageSummaries = plan.releases.filter((item) => item.version === summary.version)
					const release = rootReleases.find((item) => item.version === summary.version)!
					return {
						changes: aggregateChanges(repository, packageSummaries),
						existingBody: parseChangelog(rootEdit.after).sections.find(
							(section) => section.version === summary.version,
						)?.body,
						release,
					}
				})
				// Rebuild only the newly generated sections; historical sections come from the original file.
				rootEdit.after = updateMarkdown(
					rootEdit.before,
					additions,
					exception || result.exception,
					repository.github,
				)
			}
		} else {
			await aggregateIndependent(context, plan.releases, exception)
		}
	}

	return plan
}

function validateLimits(resolved: GenerateOptions): void {
	if (
		(resolved.maxInputChars ?? 80_000) < 4000 ||
		!Number.isFinite(resolved.maxInputChars ?? 80_000)
	) {
		throw new Error('maxInputChars must be a finite number of at least 4000.')
	}

	if ((resolved.timeoutMs ?? 1_200_000) <= 0 || !Number.isFinite(resolved.timeoutMs ?? 1_200_000)) {
		throw new Error('timeoutMs must be a positive finite number.')
	}
}
