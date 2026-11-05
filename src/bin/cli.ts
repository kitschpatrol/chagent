#!/usr/bin/env node

import path from 'node:path'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import type { AgentName, Effort } from '../lib'
import { version } from '../../package.json' with { type: 'json' }
import {
	amendRelease,
	generateChangelog,
	previewChangelog,
	reviewChangelog,
	setLogger,
	writeChangelog,
} from '../lib'
import { defaultAgent, defaultEffort, defaultModels, defaultTimeoutMs } from '../lib/defaults'

setLogger({ ...console, debug: console.error, info: console.error, log: console.error })
const controller = new AbortController()
process.once('SIGINT', () => {
	controller.abort()
})
process.once('SIGTERM', () => {
	controller.abort()
})

const cli = yargs(hideBin(process.argv))

function explicitArguments<T extends Record<string, unknown>>(args: T): Partial<T> {
	const { parsed } = cli
	const defaults = parsed !== false && 'defaulted' in parsed ? parsed.defaulted : undefined
	const keys = new Set(
		typeof defaults === 'object' && defaults !== null ? Object.keys(defaults) : [],
	)
	// Values explicitly supplied by the user remain overrides even when they equal a default.
	return Object.fromEntries(Object.entries(args).filter(([key]) => !keys.has(key))) as Partial<T>
}

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
						choices: ['codex', 'claude'],
						default: defaultAgent,
						description: 'Installed agent CLI',
						type: 'string',
					})
					.option('model', {
						defaultDescription: `${defaultModels.codex} (Codex); ${defaultModels.claude} (Claude)`,
						description: 'Agent model',
						type: 'string',
					})
					.option('effort', {
						choices: ['low', 'medium', 'high', 'xhigh', 'max'],
						default: defaultEffort,
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
					.option('github', {
						default: true,
						description: 'Enrich Git evidence using gh when available; disable with --no-github',
						type: 'boolean',
					})
					.option('cache', {
						default: true,
						description: 'Cache drafts and incremental state; disable with --no-cache',
						type: 'boolean',
					})
					.option('config', {
						defaultDescription: 'auto-detected from repository root',
						description: 'Configuration file path',
						type: 'string',
					})
					.option('timeout', {
						default: defaultTimeoutMs / 1000,
						description: 'Agent timeout in seconds',
						type: 'number',
					})
					.check((args) => {
						if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
							throw new Error('--timeout must be a positive number of seconds.')
						}

						return true
					}),
			async (args) => {
				// Only explicit flags override repository configuration; the library applies shared defaults.
				const supplied = explicitArguments(args)
				let plan = await generateChangelog({
					agent: supplied.agent as AgentName | undefined,
					cache: supplied.cache,
					configFile: supplied.config,
					cwd: args.cwd,
					effort: supplied.effort as Effort | undefined,
					github: supplied.github,
					model: supplied.model,
					rebuild: args.rebuild,
					signal: controller.signal,
					timeoutMs: supplied.timeout === undefined ? undefined : supplied.timeout * 1000,
				})
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
		.wrap(process.stdout.isTTY ? Math.min(120, cli.terminalWidth()) : 0)
		.parse()
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
	process.exitCode = 1
}
