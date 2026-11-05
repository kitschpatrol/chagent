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

setLogger({ ...console, debug: console.error, info: console.error, log: console.error })
const controller = new AbortController()
process.once('SIGINT', () => {
	controller.abort()
})
process.once('SIGTERM', () => {
	controller.abort()
})

const cli = yargs(hideBin(process.argv))
try {
	await cli
		.scriptName('chagent')
		.command(
			'$0',
			'Initialize or update changelogs from repository history.',
			(command) =>
				command
					.option('cwd', { description: 'Repository directory', type: 'string' })
					.option('agent', {
						choices: ['codex', 'claude'],
						description: 'Installed agent CLI (default: codex)',
					})
					.option('model', {
						description:
							'Agent model (Codex default: gpt-6.1-sol; Claude default: claude-opus-5-5)',
						type: 'string',
					})
					.option('effort', {
						choices: ['low', 'medium', 'high', 'xhigh', 'max'],
						description: 'Reasoning effort (default: xhigh)',
					})
					.option('interactive', {
						alias: 'i',
						default: false,
						description: 'Review a diff and optionally edit before writing',
						type: 'boolean',
					})
					.option('editor', {
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
						description: 'Enrich Git evidence using gh when available; disable with --no-github',
						type: 'boolean',
					})
					.option('cache', {
						description: 'Cache drafts and incremental state; disable with --no-cache',
						type: 'boolean',
					})
					.option('config', { description: 'Configuration file path', type: 'string' })
					.option('timeout', {
						description: 'Agent timeout in seconds (default: 1200)',
						type: 'number',
					})
					.check((args) => {
						if (
							args.timeout !== undefined &&
							(!Number.isFinite(args.timeout) || args.timeout <= 0)
						) {
							throw new Error('--timeout must be a positive number of seconds.')
						}

						return true
					}),
			async (args) => {
				let plan = await generateChangelog({
					agent: args.agent as AgentName | undefined,
					cache: args.cache,
					configFile: args.config,
					cwd: args.cwd,
					effort: args.effort as Effort | undefined,
					github: args.github,
					model: args.model,
					rebuild: args.rebuild,
					signal: controller.signal,
					timeoutMs: args.timeout === undefined ? undefined : args.timeout * 1000,
				})
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

				for (const diagnostic of plan.diagnostics) {
					process.stderr.write(diagnostic + '\n')
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
