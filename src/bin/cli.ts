#!/usr/bin/env node

import { createLogger } from 'lognow'
import path from 'node:path'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { version } from '../../package.json' with { type: 'json' }
import {
	amendRelease,
	generateChangelog,
	previewChangelog,
	reviewChangelog,
	setLogger,
	writeChangelog,
} from '../lib'
import { assertAmendable } from '../lib/amend'
import { defaultModels, defaults, maxTimeoutMinutes } from '../lib/defaults'
import { createProgressLine } from '../lib/progress'
import { assertReviewTerminal } from '../lib/review'
import { agentNames, efforts, rootChangelogs } from '../lib/types'

/**
 * Route library output: a timer on a terminal, plain lines otherwise or when
 * verbose.
 */
function createReporter(verbose: boolean, signal: AbortSignal) {
	const progress = !verbose && process.stderr.isTTY ? createProgressLine(process.stderr) : undefined

	// Restore the cursor right away, since a second interrupt kills the process outright.
	signal.addEventListener(
		'abort',
		() => {
			progress?.stop()
		},
		{ once: true },
	)

	const logDetail = (...args: unknown[]) => {
		if (progress === undefined) {
			console.error(...args)
		}
	}

	const logDebug = (...args: unknown[]) => {
		if (verbose) {
			console.error(...args)
		}
	}

	const logProblem = (...args: unknown[]) => {
		progress?.clear()
		console.error(...args)
	}

	setLogger(
		createLogger({
			logToConsole: {
				// eslint-disable-next-line unicorn/no-unnecessary-boolean-comparison -- Node types isTTY as a boolean, but it is undefined on a pipe, which would select lognow's colorized default.
				colorize: process.stderr.isTTY === true,
				getTerminalWidth: () =>
					process.stderr.isTTY ? process.stderr.columns : Number.MAX_SAFE_INTEGER,
				logger: {
					debug: logDebug,
					error: logProblem,
					info: logDetail,
					trace: logDebug,
					warn: logProblem,
				},
				showLevel: verbose,
				showName: false,
				showTime: verbose,
			},
			name: 'chagent',
			// Routing above decides which levels print.
			verbose: true,
		}),
	)

	return {
		report(message: string) {
			progress?.update(message)
		},
		async track<T>(work: () => Promise<T>): Promise<T> {
			progress?.start('Reading repository history.')
			try {
				return await work()
			} finally {
				progress?.stop()
			}
		},
	}
}

const controller = new AbortController()
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		controller.abort()
	})
}

const cli = yargs(hideBin(process.argv))

try {
	await cli
		.scriptName('chagent')
		.command(
			'$0',
			'Initialize or update changelogs from repository history.',
			(command) =>
				command
					.option('cwd', {
						default: process.cwd(),
						defaultDescription: 'current directory',
						description: 'Repository directory',
						type: 'string',
					})
					.option('agent', {
						choices: agentNames,
						defaultDescription: defaults.agent,
						description: 'Installed agent CLI',
						type: 'string',
					})
					.option('model', {
						defaultDescription: `${defaultModels.codex} (Codex); ${defaultModels.claude} (Claude)`,
						description: 'Agent model',
						type: 'string',
					})
					.option('effort', {
						choices: efforts,
						defaultDescription: defaults.effort,
						description: 'Reasoning effort',
						type: 'string',
					})
					.option('interactive', {
						alias: 'i',
						default: false,
						description: 'Review a diff and optionally edit before writing',
						type: 'boolean',
					})
					.option('editor', {
						defaultDescription: 'git var GIT_EDITOR',
						description: 'Editor command for interactive review; configure GUI editors to wait',
						type: 'string',
					})
					.option('dry-run', {
						default: false,
						description: 'Print a diff without applying changes',
						type: 'boolean',
					})
					.option('rebuild', {
						default: false,
						description: 'Reconstruct all history, replacing existing release text',
						type: 'boolean',
					})
					.option('amend', {
						default: false,
						description: 'Amend a verified unpublished release commit and matching local tags',
						type: 'boolean',
					})
					.option('root-changelog', {
						choices: rootChangelogs,
						defaultDescription: defaults.rootChangelog,
						description:
							'Monorepo root changelog: a summary of package releases, the root package alone, or none',
						type: 'string',
					})
					.option('github', {
						defaultDescription: String(defaults.github),
						description: 'Enrich Git evidence using gh when available; disable with --no-github',
						type: 'boolean',
					})
					.option('cache', {
						defaultDescription: String(defaults.cache),
						description: 'Cache drafts and incremental state; disable with --no-cache',
						type: 'boolean',
					})
					.option('config', {
						defaultDescription: 'auto-detected from repository root',
						description: 'Configuration file path',
						type: 'string',
					})
					.option('timeout', {
						defaultDescription: String(defaults.timeout),
						description: 'Agent timeout in minutes',
						type: 'number',
					})
					.option('verbose', {
						default: false,
						description: 'Log commands, cache decisions, and session details to stderr',
						type: 'boolean',
					})
					.check((args) => {
						if (
							args.timeout !== undefined &&
							(!Number.isFinite(args.timeout) ||
								args.timeout <= 0 ||
								args.timeout > maxTimeoutMinutes)
						) {
							throw new Error(
								`--timeout must be a positive number of minutes, up to ${Math.floor(maxTimeoutMinutes)}.`,
							)
						}

						return true
					}),
			async (args) => {
				if (!args.dryRun && args.interactive) {
					assertReviewTerminal()
				}

				if (!args.dryRun && args.amend) {
					await assertAmendable(args.cwd)
				}

				// Unset flags stay undefined so repository configuration can apply; the library owns defaults.
				const reporter = createReporter(args.verbose, controller.signal)
				let plan = await reporter.track(async () =>
					generateChangelog({
						agent: args.agent,
						cache: args.cache,
						configFile: args.config,
						cwd: args.cwd,
						effort: args.effort,
						github: args.github,
						model: args.model,
						onProgress(message) {
							reporter.report(message)
						},
						rebuild: args.rebuild,
						rootChangelog: args.rootChangelog,
						signal: controller.signal,
						timeout: args.timeout,
					}),
				)
				try {
					if (args.dryRun) {
						process.stdout.write(await previewChangelog(plan))
						return
					}

					if (args.interactive) {
						const reviewed = await reviewChangelog(plan, { editor: args.editor })
						if (reviewed === undefined) {
							process.stderr.write('Changelog review cancelled.\n')
							process.exitCode = 1
							return
						}

						plan = reviewed
					}

					if (args.amend) {
						await amendRelease(plan)
					} else {
						await writeChangelog(plan)
					}
				} finally {
					for (const diagnostic of plan.diagnostics) {
						process.stderr.write(diagnostic + '\n')
					}
				}

				process.stderr.write(
					plan.files.length === 0
						? 'Changelogs are up to date.\n'
						: `Updated ${plan.files.map((file) => path.relative(plan.root, file.path)).join(', ')}.\n`,
				)
			},
		)
		.alias('h', 'help')
		.version(version)
		.alias('v', 'version')
		.help()
		.strict()
		.fail((message, error: Error | undefined, instance) => {
			// Usage mistakes get help; failures while running get only their message.
			if (error !== undefined) {
				throw error
			}

			instance.showHelp()
			throw new Error(message)
		})
		.wrap(process.stdout.isTTY ? Math.min(120, cli.terminalWidth()) : 0)
		.parse()
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
	process.exitCode = 1
}
