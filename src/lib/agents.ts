import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { AgentAdapter, AgentName, Change, GenerationRequest } from './types'
import { instructions } from './instructions'
import { runCommand } from './process'
import { categories } from './types'

const CONTROL_CHARACTERS = /\p{Cc}/v
const LIST_OR_HEADING = /^(?:#{1,6}\s|[\-*]\s|\d+\.\s)/v
const responseSchema = z.strictObject({
	changes: z.array(
		z.strictObject({
			breaking: z.boolean(),
			category: z.enum(categories),
			description: z.string().min(1).max(1000),
			sources: z.array(z.string()).min(1),
		}),
	),
})

/** Validate both structured output and its evidence references before rendering. */
export function validateChanges(value: unknown, request: GenerationRequest): Change[] {
	const { changes } = responseSchema.parse(value)
	const ids = new Set(request.evidence.map((item) => item.id))
	for (const change of changes) {
		if (change.sources.some((source) => !ids.has(source))) {
			throw new Error('Agent output cites evidence that was not supplied.')
		}

		if (
			CONTROL_CHARACTERS.test(change.description) ||
			LIST_OR_HEADING.test(change.description) ||
			change.description.includes('<!--')
		) {
			throw new Error('Agent output contains a heading, multiline entry, or hidden markup.')
		}
	}

	return changes
}

function prompt(request: GenerationRequest): string {
	return `${instructions}\n\nInput data (JSON):\n${JSON.stringify({ evidence: request.evidence, existingEntries: request.existingEntries, packageName: request.packageName, scope: request.scope ?? 'package', version: request.version })}`
}

/** Create an adapter for an installed CLI using its existing authentication. */
export function createAgent(name: AgentName): AgentAdapter {
	return {
		cacheKey: name === 'claude' ? 'claude-2' : 'codex-1',
		async generate(request) {
			const directory = await mkdtemp(path.join(os.tmpdir(), 'chagent-agent-'))
			try {
				const schema = JSON.stringify(z.toJSONSchema(responseSchema, { target: 'draft-07' }))
				let value: unknown
				if (name === 'codex') {
					const schemaPath = path.join(directory, 'schema.json')
					const outputPath = path.join(directory, 'response.json')
					await writeFile(schemaPath, schema)
					await runCommand(
						'codex',
						[
							'exec',
							'--skip-git-repo-check',
							'--sandbox',
							'read-only',
							'--ephemeral',
							'--ignore-user-config',
							'--ignore-rules',
							'--color',
							'never',
							'--json',
							'--model',
							request.model ?? 'gpt-6.1-sol',
							'--config',
							`model_reasoning_effort=${JSON.stringify(request.effort ?? 'xhigh')}`,
							'--config',
							'features.shell_tool=false',
							'--config',
							'web_search="disabled"',
							'--config',
							'project_doc_max_bytes=0',
							'--output-schema',
							schemaPath,
							'--output-last-message',
							outputPath,
							'-',
						],
						{
							cwd: directory,
							input: prompt(request),
							signal: request.signal,
							timeoutMs: request.timeoutMs,
						},
					)
					value = JSON.parse(await readFile(outputPath, 'utf8'))
				} else {
					const result = await runCommand(
						'claude',
						[
							'--print',
							'--output-format',
							'json',
							'--json-schema',
							schema,
							'--tools',
							'',
							'--disable-slash-commands',
							'--no-session-persistence',
							'--setting-sources',
							'',
							'--strict-mcp-config',
							'--mcp-config',
							'{"mcpServers":{}}',
							'--permission-mode',
							'dontAsk',
							'--model',
							request.model ?? 'claude-opus-5-5',
							'--effort',
							request.effort ?? 'xhigh',
						],
						{
							allowFailure: true,
							cwd: directory,
							input: prompt(request),
							signal: request.signal,
							timeoutMs: request.timeoutMs,
						},
					)
					if (result.stdout.trim() === '') {
						throw new Error(`Claude generation failed: ${result.stderr.trim()}`)
					}

					const envelope = z.record(z.string(), z.unknown()).parse(JSON.parse(result.stdout))
					if (envelope.is_error === true) {
						throw new Error(
							`Claude generation failed: ${typeof envelope.result === 'string' ? envelope.result : 'No structured result.'}`,
						)
					}

					value = envelope.structured_output
				}

				return validateChanges(value, request)
			} finally {
				await rm(directory, { force: true, recursive: true })
			}
		},
		name,
	}
}
