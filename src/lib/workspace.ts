import path from 'node:path'
import type { PackageLink, SectionEntry } from './changelog'
import type { GenerationContext as Context } from './jobs'
import type { PackagePlan } from './package-plan'
import type {
	Change,
	ChangelogPlan,
	Release,
	ReleaseRequest,
	ReleaseSummary,
	Repository,
} from './types'
import {
	findChangelog,
	noNotableChanges,
	packageLinksDiffer,
	parseChangelog,
	styleReference,
	updateMarkdown,
	withoutPackageLinks,
} from './changelog'
import { generateReleases, prepareRelease } from './jobs'
import {
	incrementalBase,
	leavesGeneratedDraft,
	missingPackageSummaries,
	missingReleases,
	preparePackage,
	readCheckpoint,
	recordCheckpoint,
	releaseContext,
	renderPackage,
} from './package-plan'
import { git } from './process'
import { describedPackages, resolveReleases, sortReleases } from './repository'

/** A root changelog with a section for each package release. */
type IndependentPlan = {
	content?: string
	draft?: string
	draftGenerated: boolean
	file: Awaited<ReturnType<typeof findChangelog>>
	/** Summaries of the package releases the root does not record yet. */
	releases: ReleaseRequest[]
	/** Changes to repository files outside every package. */
	unreleased: { release: Release; request: ReleaseRequest }
}

/** Link to a package's release section, when its changelog has one. */
function packageLink(repository: Repository, summary: ReleaseSummary): PackageLink[] {
	if (summary.anchor === undefined) {
		return []
	}

	const relative = path.relative(repository.root, summary.changelogPath).split(path.sep).join('/')
	const target = `${relative}#${summary.anchor}`
	return [
		{
			label: `${summary.packageName} ${summary.version}`,
			url:
				repository.github === undefined
					? target
					: `https://github.com/${repository.github}/blob/HEAD/${target}`,
		},
	]
}

/** Name the root's summary of a package release. */
function summaryId(summary: ReleaseSummary): string {
	return `.@${summary.packageName}@${summary.version}`
}

async function prepareIndependent(
	context: Context,
	packages: PackagePlan[],
): Promise<IndependentPlan> {
	const { repository } = context
	const file = await findChangelog(repository.root)
	const content = context.options.rebuild ? undefined : file.content
	const parsed = parseChangelog(content ?? '')
	const details = {
		mode: content === undefined ? 'initialize' : 'update',
		styleReference: styleReference(parsed),
	} as const
	const releases: ReleaseRequest[] = []
	for (const item of packages) {
		for (const summary of missingPackageSummaries(item.summaries, content)) {
			const release = item.releases.find((candidate) => candidate.version === summary.version)!
			const request = await prepareRelease(context, item.pkg, release, details)
			// The package's own request, or the agent's research, supplies the commits.
			releases.push({
				...request,
				evidence: request.evidence.filter((evidence) => evidence.kind === 'range'),
				id: summaryId(summary),
				scope: 'repository',
			})
		}
	}

	const releaseRefs = new Set(
		packages
			.flatMap((item) => item.summaries)
			.filter((summary) => summary.version !== 'Unreleased')
			.map((summary) => summary.ref),
	)
	const ancestors = await git(repository.root, ['rev-list', '--topo-order', repository.head])
	const base = ancestors.split('\n').find((ref) => releaseRefs.has(ref))
	const release: Release = { previousRef: base, ref: repository.head, version: 'Unreleased' }
	const draft = parsed.sections.find((section) => section.version === 'Unreleased')?.body
	const checkpoint = await readCheckpoint(context, file.path, content)
	const from = await incrementalBase(context, checkpoint, release)
	const draftGenerated = checkpoint?.generated === true
	const request = await prepareRelease(context, repository.rootPackage, release, {
		...details,
		existingEntries: draft === undefined ? undefined : withoutPackageLinks(draft),
		from,
		mode: draft !== undefined && from !== undefined && draftGenerated ? 'revise' : details.mode,
		onlyRepositoryFiles: true,
	})
	return { content, draft, draftGenerated, file, releases, unreleased: { release, request } }
}

/**
 * Write a section for each package release the root does not record yet, and
 * keep the draft's links to packages with unreleased changes current.
 */
async function renderIndependent(
	context: Context,
	prepared: IndependentPlan,
	results: Map<string, Change[]>,
	summaries: ReleaseSummary[],
	exception: boolean,
): Promise<void> {
	const { plan, repository } = context
	const { content, draft, file, unreleased } = prepared
	const ordered = await sortReleases(
		repository,
		summaries.filter((summary) => summary.version !== 'Unreleased'),
	)
	const entries: SectionEntry[] = Array.from(
		missingPackageSummaries(ordered, content),
		(summary) => ({
			changes: results.get(summaryId(summary)) ?? [],
			links: packageLink(repository, summary),
			release: {
				date: summary.date,
				ref: summary.ref,
				tag: summary.tag,
				version: `${summary.packageName}@${summary.version}`,
			},
		}),
	)

	const changes = results.get(unreleased.request.id) ?? []
	const links = summaries
		.filter((summary) => summary.version === 'Unreleased')
		.flatMap((summary) => packageLink(repository, summary))
	const revise = unreleased.request.mode === 'revise' && results.has(unreleased.request.id)
	if (revise || changes.length > 0 || packageLinksDiffer(draft, links)) {
		entries.push({ changes, existingBody: draft, links, release: unreleased.release, revise })
	}

	const after = updateMarkdown(
		content,
		entries,
		exception,
		repository.github,
		ordered.map((summary) => `${summary.packageName}@${summary.version}`),
	)
	if (after !== file.content) {
		plan.files.push({ after, before: file.content, path: file.path })
	}

	recordCheckpoint(
		context,
		file.path,
		after,
		unreleased.release,
		leavesGeneratedDraft(entries, prepared.draftGenerated),
	)
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
	// A root release that is yet to be recorded can link to package history written earlier.
	const linksHistory =
		!shared ||
		missingReleases(rootReleases, rootContent).some((release) => release.version !== 'Unreleased')
	const packages: PackagePlan[] = []
	for (const pkg of describedPackages(repository)) {
		packages.push(await preparePackage(context, pkg, linksHistory))
	}

	const root = shared ? await preparePackage(context, repository.rootPackage) : undefined
	const independent = shared ? undefined : await prepareIndependent(context, packages)
	const requests = [...packages, ...(root === undefined ? [] : [root])].flatMap((pkg) =>
		pkg.work.map((item) => item.request),
	)
	if (independent !== undefined) {
		requests.push(...independent.releases, independent.unreleased.request)
	}

	const results = await generateReleases(context, requests)
	const summaries = packages.flatMap((pkg) => renderPackage(context, pkg, results))
	plan.releases.push(...summaries)
	const exception = packages.some((pkg) => pkg.exception)
	if (root !== undefined) {
		const quiet = quietReleases(plan, packages)
		// A package's release belongs to a root release only when it shares that release's commit.
		renderPackage(
			context,
			{ ...root, exception: exception || root.exception },
			results,
			(release) =>
				summaries
					.filter(
						(summary) =>
							summary.version === release.version &&
							summary.ref === release.ref &&
							!quiet.has(`${summary.changelogPath}@${summary.version}`),
					)
					.flatMap((summary) => packageLink(repository, summary)),
		)
	} else if (independent !== undefined) {
		await renderIndependent(context, independent, results, summaries, exception)
	}
}
