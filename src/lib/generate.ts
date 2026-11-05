import { realpath } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import { z } from 'zod'
import type { GenerationContext as Context, GenerationJob } from './generation'
import type {
	Category,
	Change,
	ChangelogPlan,
	GenerateOptions,
	PackageInfo,
	Release,
	ReleaseSummary,
	Repository,
} from './types'
import { createAgent } from './agents'
import { hash, readCache } from './cache'
import { findChangelog, LINE_BOUNDARY, parseChangelog, updateMarkdown } from './changelog'
import { loadConfig } from './config'
import { defaultAgent, defaultTimeoutMs } from './defaults'
import { enrichReleaseDates } from './evidence'
import { generateJobs, prepareGeneration } from './generation'
import { instructionVersion } from './instructions'
import { git, isAncestor } from './process'
import { hasNodeException, inspectRepository, resolveReleases } from './repository'
import { categories } from './types'

const checkpointSchema = z.object({
	baseRef: z.string(),
	contentHash: z.string(),
	head: z.string(),
	instructionVersion: z.literal(instructionVersion),
	path: z.string(),
})
const HEADING_PREFIX = /^#{1,2}\s+/v
const INLINE_LINK = /\[([^\]]+)\]\([^\)]*\)/gv
const ANCHOR_PUNCTUATION = /[^\p{L}\p{N}_\s\-]/gv
const ANCHOR_SPACE = /\s/gv
type PackagePlan = {
	content?: string
	exception: boolean
	file: Awaited<ReturnType<typeof findChangelog>>
	releases: Release[]
	summaries: ReleaseSummary[]
	work: Array<{ existingBody?: string; job: GenerationJob; release: Release; shouldWrite: boolean }>
}

type IndependentPlan = {
	content?: string
	file: Awaited<ReturnType<typeof findChangelog>>
	job: GenerationJob
	release: Release
}

function recordCheckpoint(
	context: Context,
	file: string,
	content: string,
	release?: Release,
): void {
	if (release === undefined || context.options.cache === false) {
		return
	}

	context.plan.checkpoints.push({
		baseRef: release.previousRef ?? 'initial',
		contentHash: hash(content),
		head: context.repository.head,
		instructionVersion,
		path: file,
	})
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

	return (await isAncestor(context.repository.root, result.data.head, release.ref))
		? result.data.head
		: undefined
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

async function preparePackage(
	context: Context,
	pkg: PackageInfo,
	aggregateHistory = false,
	aggregateContent?: string,
): Promise<PackagePlan> {
	const { repository } = context
	const file = await findChangelog(path.join(repository.root, pkg.directory))
	const content = context.options.rebuild === true ? undefined : file.content
	const mode = content === undefined ? 'initialize' : 'update'
	const releases = await resolveReleases(repository, pkg, context.options, context.options.release)
	const missing = missingReleases(releases, content)
	const parsed = parseChangelog(content ?? '')
	const draft = parsed.sections.find((section) => section.version === 'Unreleased')
	const newest = releases.findLast((release) => release.version !== 'Unreleased')
	const draftPromoted = draft !== undefined && newest !== undefined && missing.includes(newest)
	const work: PackagePlan['work'] = []
	const summaries: ReleaseSummary[] = []
	for (const release of releases) {
		const shouldWrite = missing.includes(release)
		if (!shouldWrite && !aggregateHistory) {
			continue
		}

		const summary: ReleaseSummary = {
			changelogPath: file.path,
			changes: [],
			date: release.date,
			packageDirectory: pkg.directory,
			packageName: pkg.name,
			ref: release.ref,
			tag: release.tag,
			version: release.version,
		}
		summaries.push(summary)
		// Retain release boundaries without regenerating summaries already present at the root.
		if (
			!shouldWrite &&
			aggregateContent !== undefined &&
			missingPackageSummaries([summary], aggregateContent).length === 0
		) {
			continue
		}

		const ownsDraft = draftPromoted ? release === newest : release.version === 'Unreleased'
		const existingBody = ownsDraft ? draft?.body : undefined
		const from =
			existingBody === undefined
				? undefined
				: await incrementalBase(context, file.path, content, release)
		const job = await prepareGeneration(context, pkg, release, existingBody ?? '', mode, from)
		work.push({ existingBody, job, release, shouldWrite })
		summary.changes = job.changes
	}

	const exception = await hasNodeException(repository, pkg, releases)
	return { content, exception, file, releases, summaries, work }
}

function renderPackage(context: Context, prepared: PackagePlan): void {
	const { plan, repository } = context
	const { content, exception, file, releases, summaries, work } = prepared
	const entries: Parameters<typeof updateMarkdown>[1] = []
	for (const { existingBody, job, release, shouldWrite } of work) {
		if (shouldWrite && (release.version !== 'Unreleased' || job.changes.length > 0)) {
			entries.push({ changes: job.changes, existingBody, release })
		}
	}

	const after = updateMarkdown(content, entries, exception, repository.github)
	addAnchors(summaries, after)

	if (after !== file.content) {
		plan.files.push({ after, before: file.content, path: file.path })
	}

	recordCheckpoint(context, file.path, after, releases.at(-1))
}

function packageLink(repository: Repository, summary: ReleaseSummary): string {
	const relative = path.relative(repository.root, summary.changelogPath).split(path.sep).join('/')
	const anchor =
		summary.anchor ??
		(summary.version === 'Unreleased'
			? 'unreleased'
			: `${summary.version.replaceAll('.', '')}${summary.date === undefined ? '' : '---' + summary.date}`)
	return repository.github === undefined
		? `${relative}#${anchor}`
		: `https://github.com/${repository.github}/blob/HEAD/${relative}#${anchor}`
}

function addAnchors(summaries: ReleaseSummary[], content: string): void {
	const { sections } = parseChangelog(content)
	for (const summary of summaries) {
		const section = sections.find((item) => item.version === summary.version)
		if (section !== undefined) {
			summary.anchor = section.heading
				.trim()
				.replace(HEADING_PREFIX, '')
				.replaceAll(INLINE_LINK, '$1')
				.toLowerCase()
				.replaceAll(ANCHOR_PUNCTUATION, '')
				.replaceAll(ANCHOR_SPACE, '-')
		}
	}
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
				category: 'Maintenance',
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

function promotePackageDraft(
	content: string | undefined,
	summary: ReleaseSummary,
	repository: Repository,
): { changes: Change[]; content: string | undefined } {
	const changes: Change[] = []
	const draft = parseChangelog(content ?? '').sections.find(
		(section) => section.version === 'Unreleased',
	)
	if (content === undefined || draft === undefined) {
		return { changes, content }
	}

	const source = `[${summary.packageName} Unreleased](`
	const target = `[${summary.packageName} ${summary.version}](${packageLink(repository, summary)})`
	const remaining: string[] = []
	let category: Category = 'Changed'
	for (const line of draft.body.split(LINE_BOUNDARY)) {
		category = categories.find((item) => line.trimEnd() === `### ${item}`) ?? category
		const breaking = line.startsWith('- **Breaking:** ')
		const prefix = breaking ? '- **Breaking:** ' : '- '
		const end = line.indexOf(')', prefix.length + source.length)
		if (end === -1 || !line.startsWith(prefix + source)) {
			remaining.push(line)
			continue
		}

		changes.push({
			breaking,
			category,
			description: target + line.slice(end + 1).trimEnd(),
			sources: [],
		})
	}

	if (changes.length === 0) {
		return { changes, content }
	}

	const meaningful = remaining.some(
		(line) => line.trim() !== '' && categories.every((item) => line.trimEnd() !== `### ${item}`),
	)
	const replacement = meaningful ? draft.heading + remaining.join('') : ''
	return {
		changes,
		content: content.slice(0, draft.start) + replacement + content.slice(draft.end),
	}
}

function missingPackageSummaries(summaries: ReleaseSummary[], content = ''): ReleaseSummary[] {
	const parsed = parseChangelog(content)
	const known = new Set(parsed.sections.map((section) => section.version))
	return summaries
		.toSorted((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))
		.filter((summary) => {
			if (
				summary.version === 'Unreleased' ||
				known.has(`${summary.packageName}@${summary.version}`)
			) {
				return false
			}

			return parsed.sections.every((section) => {
				const prefix = summary.packageName + '@'
				const version = section.version.startsWith(prefix)
					? section.version.slice(prefix.length)
					: ''
				return semver.valid(version) === null || semver.lt(version, summary.version)
			})
		})
}

async function prepareIndependent(
	context: Context,
	summaries: ReleaseSummary[],
): Promise<IndependentPlan> {
	const { repository } = context
	const file = await findChangelog(repository.root)
	const content = context.options.rebuild === true ? undefined : file.content
	let remaining = content
	for (const summary of missingPackageSummaries(summaries, content)) {
		remaining = promotePackageDraft(remaining, summary, repository).content
	}

	const releaseRefs = new Set(
		summaries.filter((summary) => summary.version !== 'Unreleased').map((summary) => summary.ref),
	)
	const ancestors = await git(repository.root, ['rev-list', '--topo-order', repository.head])
	const base = ancestors.split('\n').find((ref) => releaseRefs.has(ref))
	const release: Release = { previousRef: base, ref: repository.head, version: 'Unreleased' }
	const draft = parseChangelog(remaining ?? '').sections.find(
		(section) => section.version === 'Unreleased',
	)?.body
	const from = await incrementalBase(context, file.path, remaining, release)
	const job = await prepareGeneration(
		context,
		repository.rootPackage,
		release,
		draft ?? '',
		content === undefined ? 'initialize' : 'update',
		from,
		true,
	)
	return { content, file, job, release }
}

function aggregateIndependent(
	context: Context,
	prepared: IndependentPlan,
	summaries: ReleaseSummary[],
	exception: boolean,
): void {
	const { plan, repository } = context
	const { file } = prepared
	let { content } = prepared
	const entries: Parameters<typeof updateMarkdown>[1] = []
	for (const summary of missingPackageSummaries(summaries, content)) {
		const label = `${summary.packageName}@${summary.version}`
		const promoted = promotePackageDraft(content, summary, repository)
		content = promoted.content
		entries.push({
			changes: [...promoted.changes, ...aggregateChanges(repository, [summary])],
			release: { date: summary.date, ref: summary.ref, tag: summary.tag, version: label },
		})
	}

	const unreleased = aggregateChanges(
		repository,
		summaries.filter((summary) => summary.version === 'Unreleased'),
	)
	const draft = parseChangelog(content ?? '').sections.find(
		(section) => section.version === 'Unreleased',
	)?.body
	unreleased.push(...prepared.job.changes)
	if (unreleased.length > 0) {
		entries.push({
			changes: unreleased,
			existingBody: draft,
			release: { ref: repository.head, version: 'Unreleased' },
		})
	}

	const after = updateMarkdown(content, entries, exception, repository.github)
	if (after !== file.content) {
		plan.files.push({ after, before: file.content, path: file.path })
	}

	recordCheckpoint(context, file.path, after, prepared.release)
}

function aggregateShared(context: Context, prepared: PackagePlan, exception: boolean): void {
	const { plan, repository } = context
	renderPackage(context, prepared)
	const rootEdit = plan.files.find((file) => path.dirname(file.path) === repository.root)
	if (rootEdit === undefined) {
		return
	}

	const additions = prepared.summaries.map((summary) => ({
		changes: aggregateChanges(
			repository,
			plan.releases.filter((item) => item.version === summary.version),
		),
		existingBody: parseChangelog(rootEdit.after).sections.find(
			(section) => section.version === summary.version,
		)?.body,
		release: prepared.releases.find((item) => item.version === summary.version)!,
	}))
	rootEdit.after = updateMarkdown(
		prepared.content,
		additions,
		exception || prepared.exception,
		repository.github,
	)
}

async function generateWorkspace(context: Context): Promise<void> {
	const { options, plan, repository } = context
	const rootReleases = await resolveReleases(
		repository,
		repository.rootPackage,
		options,
		options.release,
	)
	const shared = rootReleases.some((release) => release.version !== 'Unreleased')
	const rootFile = await findChangelog(repository.root)
	const needsPackageHistory =
		!shared ||
		missingReleases(rootReleases, options.rebuild === true ? undefined : rootFile.content).some(
			(release) => release.version !== 'Unreleased',
		)
	const packages: PackagePlan[] = []
	for (const pkg of repository.packages) {
		packages.push(
			await preparePackage(
				context,
				pkg,
				needsPackageHistory,
				shared || options.rebuild === true ? undefined : rootFile.content,
			),
		)
	}

	const summaries = packages.flatMap((pkg) => pkg.summaries)
	const root = shared ? await preparePackage(context, repository.rootPackage) : undefined
	const independent = shared ? undefined : await prepareIndependent(context, summaries)
	const jobs = packages.flatMap((pkg) => pkg.work.map((item) => item.job))
	jobs.push(...(root?.work.map((item) => item.job) ?? []))
	if (independent !== undefined) {
		jobs.push(independent.job)
	}

	await generateJobs(context, jobs)
	for (const pkg of packages) {
		renderPackage(context, pkg)
		plan.releases.push(...pkg.summaries)
	}

	const exception = packages.some((pkg) => pkg.exception)
	if (root !== undefined) {
		aggregateShared(context, root, exception)
	} else if (independent !== undefined) {
		aggregateIndependent(context, independent, summaries, exception)
	}
}

/** Generate reviewable edits from Git history without changing tracked files. */
export async function generateChangelog(options: GenerateOptions = {}): Promise<ChangelogPlan> {
	const gitRoot = await git(options.cwd ?? process.cwd(), ['rev-parse', '--show-toplevel'])
	const root = await realpath(gitRoot)
	const config = await loadConfig(root, options.configFile)
	const selected = Object.fromEntries(
		Object.entries(options as Record<string, unknown>).filter(([, value]) => value !== undefined),
	) as GenerateOptions
	const resolved = { ...config, ...selected }
	validateLimits(resolved)

	const repository = await inspectRepository(root, resolved)
	const agent =
		typeof resolved.agent === 'object'
			? resolved.agent
			: createAgent(resolved.agent ?? defaultAgent)
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
		const result = await preparePackage(context, repository.rootPackage)
		await generateJobs(
			context,
			result.work.map((item) => item.job),
		)
		renderPackage(context, result)
		plan.releases.push(...result.summaries)
	} else {
		await generateWorkspace(context)
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

	if (
		(resolved.timeoutMs ?? defaultTimeoutMs) <= 0 ||
		!Number.isFinite(resolved.timeoutMs ?? defaultTimeoutMs)
	) {
		throw new Error('timeoutMs must be a positive finite number.')
	}
}
