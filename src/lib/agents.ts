import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type {
	AgentAdapter,
	AgentName,
	Change,
	GenerationRequest,
	HistoryChangeSet,
	HistoryRequest,
} from './types'
import { historyInstructions, instructions } from './instructions'
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
const historyResponseSchema = z.strictObject({
	releases: z.array(z.strictObject({ changes: responseSchema.shape.changes, id: z.string() })),
})

/**
 * Validate completeness, release identity, and citations before accepting any
 * historical output.
 */
export function validateHistory(value: unknown, request: HistoryRequest): HistoryChangeSet[] {
	const { releases } = historyResponseSchema.parse(value)
	const expected = new Map(request.releases.map((release) => [release.id, release]))
	const seen = new Set<string>()
	for (const release of releases) {
		const input = expected.get(release.id)
		if (input === undefined || seen.has(release.id)) {
			throw new Error('Agent history output contains an unknown or duplicate release id.')
		}

		validateChanges({ changes: release.changes }, { ...input, timeoutMs: request.timeoutMs })
		seen.add(release.id)
	}

	if (seen.size !== expected.size) {
		throw new Error('Agent history output omitted requested releases.')
	}

	return releases
}

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
	return `${instructions}\n\nInput data (JSON):\n${JSON.stringify({ evidence: request.evidence, existingEntries: request.existingEntries, initialRelease: request.initialRelease ?? false, mode: request.mode ?? 'update', packageName: request.packageName, repository: request.repository, scope: request.scope ?? 'package', version: request.version })}`
}

type Invocation = Pick<GenerationRequest, 'effort' | 'model' | 'signal' | 'timeoutMs'> & {
	cwd?: string
}

async function invokeAgent(
	name: AgentName,
	request: Invocation,
	input: string,
	responseFormat: z.ZodType,
): Promise<unknown> {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'chagent-agent-'))
	try {
		const research = request.cwd !== undefined
		const cwd = request.cwd ?? directory
		const schema = JSON.stringify(z.toJSONSchema(responseFormat, { target: 'draft-07' }))
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
					`features.shell_tool=${String(research)}`,
					'--config',
					'approval_policy="never"',
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
					cwd,
					input,
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
					research ? 'Read,Glob,Grep,Bash' : '',
					'--safe-mode',
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
					cwd,
					input,
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

		return value
	} finally {
		await rm(directory, { force: true, recursive: true })
	}
}

/** Create an adapter for an installed CLI using its existing authentication. */
export function createAgent(name: AgentName): AgentAdapter {
	return {
		cacheKey: name === 'claude' ? 'claude-4' : 'codex-3',
		async generate(request) {
			const result = await invokeAgent(
				name,
				{ ...request, cwd: request.repository?.root },
				prompt(request),
				responseSchema,
			)
			return validateChanges(result, request)
		},
		async generateHistory(request) {
			const input = `${instructions}\n\n${historyInstructions}\n\nInput data (JSON):\n${JSON.stringify({ releases: request.releases, repositoryRoot: request.repositoryRoot })}`
			const result = await invokeAgent(
				name,
				{ ...request, cwd: request.repositoryRoot },
				input,
				historyResponseSchema,
			)
			return validateHistory(result, request)
		},
		name,
		repositoryAccess: true,
	}
}
