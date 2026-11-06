import path from 'node:path'
import type { GenerationContext as Context } from './jobs'
import type { PackagePlan } from './package-plan'
import type {
	Category,
	Change,
	ChangelogPlan,
	Release,
	ReleaseRequest,
	ReleaseSummary,
	Repository,
} from './types'
import {
	findChangelog,
	LINE_BOUNDARY,
	noNotableChanges,
	parseChangelog,
	updateMarkdown,
} from './changelog'
import { generateReleases, prepareRelease } from './jobs'
import {
	incrementalBase,
	missingPackageSummaries,
	missingReleases,
	preparePackage,
	recordCheckpoint,
	releaseContext,
	renderPackage,
} from './package-plan'
import { git } from './process'
import { resolveReleases } from './repository'
import { categories } from './types'

type IndependentPlan = {
	content?: string
	file: Awaited<ReturnType<typeof findChangelog>>
	release: Release
	request: ReleaseRequest
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

async function prepareIndependent(
	context: Context,
	summaries: ReleaseSummary[],
): Promise<IndependentPlan> {
	const { repository } = context
	const file = await findChangelog(repository.root)
	const content = context.options.rebuild ? undefined : file.content
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
	const request = await prepareRelease(
		context,
		repository.rootPackage,
		release,
		draft ?? '',
		content === undefined ? 'initialize' : 'update',
		from,
		true,
	)
	return { content, file, release, request }
}

function aggregateIndependent(
	context: Context,
	prepared: IndependentPlan,
	results: Map<string, Change[]>,
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
	unreleased.push(...(results.get(prepared.request.id) ?? []))
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

/**
 * Find package releases whose own section records no notable changes, so a
 * shared release summary can leave them out.
 */
function quietReleases(plan: ChangelogPlan, packages: PackagePlan[]): Set<string> {
	const quiet = new Set<string>()
	for (const { file } of packages) {
		const text = plan.files.find((edit) => edit.path === file.path)?.after ?? file.content ?? ''
		for (const section of parseChangelog(text).sections) {
			if (section.body.trim() === noNotableChanges) {
				quiet.add(`${file.path}@${section.version}`)
			}
		}
	}

	return quiet
}

function aggregateShared(
	context: Context,
	prepared: PackagePlan,
	results: Map<string, Change[]>,
	exception: boolean,
	quiet: Set<string>,
): void {
	const { plan, repository } = context
	renderPackage(context, prepared, results)
	const rootEdit = plan.files.find((file) => path.dirname(file.path) === repository.root)
	if (rootEdit === undefined) {
		return
	}

	// A package's release belongs to a root release only when it shares that release's commit.
	const additions = prepared.summaries.map((summary) => ({
		changes: aggregateChanges(
			repository,
			plan.releases.filter(
				(item) =>
					item.version === summary.version &&
					item.ref === summary.ref &&
					!quiet.has(`${item.changelogPath}@${item.version}`),
			),
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

/** Generate package changelogs and the root changelog that summarizes them. */
export async function generateWorkspace(context: Context): Promise<void> {
	const { options, plan, repository } = context
	const rootReleases = await resolveReleases(
		repository,
		repository.rootPackage,
		options,
		releaseContext(options, repository.rootPackage),
	)
	const shared = rootReleases.some((release) => release.version !== 'Unreleased')
	const rootFile = await findChangelog(repository.root)
	const rootContent = options.rebuild ? undefined : rootFile.content
	const rootMissing = shared ? missingReleases(rootReleases, rootContent) : undefined
	const needsPackageHistory =
		rootMissing === undefined || rootMissing.some((release) => release.version !== 'Unreleased')
	const recordedAtRoot = (summary: ReleaseSummary): boolean =>
		rootMissing === undefined
			? rootContent !== undefined && missingPackageSummaries([summary], rootContent).length === 0
			: rootMissing.every(
					(release) => release.version !== summary.version || release.ref !== summary.ref,
				)
	const packages: PackagePlan[] = []
	for (const pkg of repository.packages) {
		packages.push(await preparePackage(context, pkg, needsPackageHistory, recordedAtRoot))
	}

	const root = shared ? await preparePackage(context, repository.rootPackage) : undefined
	const independent = shared
		? undefined
		: await prepareIndependent(
				context,
				packages.flatMap((pkg) => pkg.summaries),
			)
	const requests = [...packages, ...(root === undefined ? [] : [root])].flatMap((pkg) =>
		pkg.work.map((item) => item.request),
	)
	if (independent !== undefined) {
		requests.push(independent.request)
	}

	const results = await generateReleases(context, requests)
	const summaries = packages.flatMap((pkg) => renderPackage(context, pkg, results))
	plan.releases.push(...summaries)
	const exception = packages.some((pkg) => pkg.exception)
	if (root !== undefined) {
		aggregateShared(context, root, results, exception, quietReleases(plan, packages))
	} else if (independent !== undefined) {
		aggregateIndependent(context, independent, results, summaries, exception)
	}
}
