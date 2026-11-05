import path from 'node:path'
import semver from 'semver'
import { z } from 'zod'
import type { GenerationContext as Context } from './jobs'
import type { Change, PackageInfo, Release, ReleaseRequest, ReleaseSummary } from './types'
import { hash, readCache } from './cache'
import { findChangelog, parseChangelog, updateMarkdown } from './changelog'
import { instructionVersion } from './instructions'
import { prepareRelease } from './jobs'
import { isAncestor } from './process'
import { hasNodeException, resolveReleases } from './repository'

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

/** A package's releases and changelog, ready for generation and then rendering. */
export type PackagePlan = {
	content?: string
	exception: boolean
	file: Awaited<ReturnType<typeof findChangelog>>
	releases: Release[]
	summaries: ReleaseSummary[]
	work: Array<{
		existingBody?: string
		release: Release
		request: ReleaseRequest
		shouldWrite: boolean
	}>
}

/**
 * Remember what this run covered, so the next one can research only newer
 * commits.
 */
export function recordCheckpoint(
	context: Context,
	file: string,
	content: string,
	release?: Release,
): void {
	if (release === undefined || !context.options.cache) {
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

/**
 * Find the commit a changelog already covers, when its checkpoint is still
 * valid.
 */
export async function incrementalBase(
	context: Context,
	file: string,
	content: string | undefined,
	release: Release,
): Promise<string | undefined> {
	if (content === undefined || !context.options.cache) {
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

/** Select the releases newer than anything the changelog already records. */
export function missingReleases(releases: Release[], content = ''): Release[] {
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

/** Resolve a package's releases and prepare requests for those it still needs. */
export async function preparePackage(
	context: Context,
	pkg: PackageInfo,
	aggregateHistory = false,
	aggregateContent?: string,
): Promise<PackagePlan> {
	const { repository } = context
	const file = await findChangelog(path.join(repository.root, pkg.directory))
	const content = context.options.rebuild ? undefined : file.content
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
		const request = await prepareRelease(context, pkg, release, existingBody ?? '', mode, from)
		work.push({ existingBody, release, request, shouldWrite })
	}

	const exception = await hasNodeException(repository, pkg, releases)
	return { content, exception, file, releases, summaries, work }
}

/** Write a package's edit into the plan and complete its summaries. */
export function renderPackage(
	context: Context,
	prepared: PackagePlan,
	results: Map<string, Change[]>,
): ReleaseSummary[] {
	const { plan, repository } = context
	const { content, exception, file, releases, summaries, work } = prepared
	const entries: Parameters<typeof updateMarkdown>[1] = []
	const changesByVersion = new Map<string, Change[]>()
	for (const { existingBody, release, request, shouldWrite } of work) {
		const changes = results.get(request.id) ?? []
		changesByVersion.set(release.version, changes)
		if (shouldWrite && (release.version !== 'Unreleased' || changes.length > 0)) {
			entries.push({ changes, existingBody, release })
		}
	}

	const after = updateMarkdown(content, entries, exception, repository.github)
	if (after !== file.content) {
		plan.files.push({ after, before: file.content, path: file.path })
	}

	recordCheckpoint(context, file.path, after, releases.at(-1))
	const { sections } = parseChangelog(after)
	return summaries.map((summary) => ({
		...summary,
		anchor: headingAnchor(sections.find((section) => section.version === summary.version)?.heading),
		changes: changesByVersion.get(summary.version) ?? [],
	}))
}

function headingAnchor(heading: string | undefined): string | undefined {
	return heading
		?.trim()
		.replace(HEADING_PREFIX, '')
		.replaceAll(INLINE_LINK, '$1')
		.toLowerCase()
		.replaceAll(ANCHOR_PUNCTUATION, '')
		.replaceAll(ANCHOR_SPACE, '-')
}

/**
 * Find package releases not yet recorded in an independently versioned root
 * changelog.
 */
export function missingPackageSummaries(
	summaries: ReleaseSummary[],
	content = '',
): ReleaseSummary[] {
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
