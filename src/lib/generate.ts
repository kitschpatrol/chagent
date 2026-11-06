import { realpath } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import type { GenerationContext as Context } from './jobs'
import type { PackagePlan } from './package-plan'
import type { ChangelogPlan, GenerateOptions } from './types'
import { engines } from '../../package.json' with { type: 'json' }
import { createAgent } from './agents'
import { parseChangelog } from './changelog'
import { loadConfig, resolveConfig } from './config'
import { enrichReleaseDates } from './evidence'
import { generateReleases } from './jobs'
import { log } from './log'
import { preparePackage, renderPackage } from './package-plan'
import { git } from './process'
import { describedPackages, inspectRepository } from './repository'
import { generateWorkspace } from './workspace'

/**
 * Package managers only warn about unsupported engines, so refuse before an
 * agent session rather than fail afterward on a missing API.
 */
export function assertSupportedNode(version = process.versions.node): void {
	if (!semver.satisfies(version, engines.node, { includePrerelease: true })) {
		throw new Error(`chagent requires Node.js ${engines.node}, but this is Node.js ${version}.`)
	}
}

/** Generate reviewable edits from Git history without changing tracked files. */
export async function generateChangelog(options: GenerateOptions = {}): Promise<ChangelogPlan> {
	assertSupportedNode()
	const cwd = options.cwd ?? process.cwd()
	const root = await realpath(await git(cwd, ['rev-parse', '--show-toplevel']))
	const {
		agent: selected,
		configFile,
		cwd: _cwd,
		onProgress,
		rebuild = false,
		release,
		signal,
		...overrides
	} = options
	const config = resolveConfig(
		await loadConfig(root, configFile),
		typeof selected === 'string' ? { ...overrides, agent: selected } : overrides,
	)
	log.debug(`Resolved options: ${JSON.stringify(config)}`)
	const repository = await inspectRepository(root, config)
	log.debug(
		`Repository ${root} at ${repository.head}: ${repository.tags.length} reachable tags, ${repository.packages.length} workspace packages.`,
	)
	if (config.rootChangelog === 'none' && describedPackages(repository).length === 0) {
		throw new Error(
			'The root changelog is set to "none", but no workspace packages remain to describe, so there is no changelog to generate. Choose another root changelog mode, or configure packages that are not skipped.',
		)
	}

	const agent = typeof selected === 'object' ? selected : createAgent(config.agent)
	const plan: ChangelogPlan = {
		checkpoints: [],
		diagnostics: [],
		files: [],
		head: repository.head,
		releases: [],
		root,
	}
	const github = config.github && (await enrichReleaseDates(repository, plan.diagnostics, signal))
	// Like bumpp, a release context describes the package being released from cwd.
	const location = path
		.relative(root, await realpath(cwd))
		.split(path.sep)
		.join('/')
	const releaseDirectory =
		repository.packages.findLast(
			({ directory }) => location === directory || location.startsWith(`${directory}/`),
		)?.directory ?? '.'

	const context: Context = {
		agent,
		cacheDirectory:
			config.cache && agent.cacheKey !== undefined
				? path.join(repository.gitDirectory, 'chagent', 'drafts')
				: undefined,
		options: { ...config, github, onProgress, rebuild, release, releaseDirectory, signal },
		plan,
		repository,
	}
	if (repository.packages.length > 0 && config.rootChangelog === 'summary') {
		await generateWorkspace(context)
	} else {
		await generatePackages(context)
	}

	if (rebuild) {
		keepEmptyRebuilds(plan)
	}

	return plan
}

/** Generate each changelog on its own, with no root summary. */
async function generatePackages(context: Context): Promise<void> {
	const { options, plan, repository } = context
	const packages =
		options.rootChangelog === 'none'
			? describedPackages(repository)
			: [repository.rootPackage, ...describedPackages(repository)]
	const prepared: PackagePlan[] = []
	for (const pkg of packages) {
		prepared.push(await preparePackage(context, pkg))
	}

	const results = await generateReleases(
		context,
		prepared.flatMap((item) => item.work.map((work) => work.request)),
	)
	for (const item of prepared) {
		plan.releases.push(...renderPackage(context, item, results))
	}
}

/** A rebuild that finds nothing to record must not erase an existing changelog. */
function keepEmptyRebuilds(plan: ChangelogPlan): void {
	plan.files = plan.files.filter((edit) => {
		if (edit.before === undefined || parseChangelog(edit.after).sections.length > 0) {
			return true
		}

		plan.diagnostics.push(
			`The rebuild found nothing to record in ${path.relative(plan.root, edit.path)}, so it was left unchanged.`,
		)
		return false
	})
}
