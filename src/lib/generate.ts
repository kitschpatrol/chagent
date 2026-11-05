import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { GenerationContext as Context } from './jobs'
import type { ChangelogPlan, GenerateOptions } from './types'
import { createAgent } from './agents'
import { loadConfig, resolveConfig } from './config'
import { enrichReleaseDates } from './evidence'
import { generateReleases } from './jobs'
import { preparePackage, renderPackage } from './package-plan'
import { git } from './process'
import { inspectRepository } from './repository'
import { generateWorkspace } from './workspace'

/** Generate reviewable edits from Git history without changing tracked files. */
export async function generateChangelog(options: GenerateOptions = {}): Promise<ChangelogPlan> {
	const gitRoot = await git(options.cwd ?? process.cwd(), ['rev-parse', '--show-toplevel'])
	const root = await realpath(gitRoot)
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
	const repository = await inspectRepository(root, config)
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

	const context: Context = {
		agent,
		cacheDirectory:
			config.cache && agent.cacheKey !== undefined
				? path.join(repository.gitDirectory, 'chagent', 'drafts')
				: undefined,
		options: { ...config, github, onProgress, rebuild, release, signal },
		plan,
		repository,
	}
	if (repository.packages.length === 0) {
		const prepared = await preparePackage(context, repository.rootPackage)
		const results = await generateReleases(
			context,
			prepared.work.map((item) => item.request),
		)
		plan.releases.push(...renderPackage(context, prepared, results))
	} else {
		await generateWorkspace(context)
	}

	return plan
}
