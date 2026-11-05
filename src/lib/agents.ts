import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type {
	AgentAdapter,
	AgentName,
	Change,
	ChangeSet,
	GenerationRequest,
	GenerationResponse,
	ReleaseRequest,
} from './types'
import { defaultModels } from './defaults'
import { instructions } from './instructions'
import { runCommand } from './process'
import { categories } from './types'

const CONTROL_CHARACTERS = /\p{Cc}/v
const LIST_OR_HEADING = /^(?:#{1,6}\s|[\-*]\s|\d+\.\s)/v
const responseSchema = z.strictObject({
	releases: z.array(
		z.strictObject({
			changes: z.array(
				z.strictObject({
					breaking: z.boolean(),
					category: z.enum(categories),
					description: z.string().min(1).max(1000),
					sources: z.array(z.string()).min(1),
				}),
			),
			id: z.string(),
		}),
	),
})
const responseJsonSchema = JSON.stringify(z.toJSONSchema(responseSchema, { target: 'draft-07' }))

function validateChanges(changes: Change[], release: ReleaseRequest): void {
	const ids = new Set(release.evidence.map((item) => item.id))
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
}

/**
 * Validate structure, completeness, release identity, and citations before
 * accepting any adapter's output.
 */
export function validateResponse(value: unknown, releases: ReleaseRequest[]): ChangeSet[] {
	const response = responseSchema.parse(value)
	const expected = new Map(releases.map((release) => [release.id, release]))
	const seen = new Set<string>()
	for (const { changes, id } of response.releases) {
		const release = expected.get(id)
		if (release === undefined || seen.has(id)) {
			throw new Error('Agent output contains an unknown or duplicate release id.')
		}

		validateChanges(changes, release)
		seen.add(id)
	}

	if (seen.size !== expected.size) {
		throw new Error('Agent output omitted requested releases.')
	}

	return response.releases
}

function prompt({ releases, repositoryRoot }: GenerationRequest): string {
	return `${instructions}\n\nInput data (JSON):\n${JSON.stringify({ releases, repositoryRoot })}`
}

async function runCodex(request: GenerationRequest): Promise<unknown> {
	const { repositoryRoot, settings } = request
	const directory = await mkdtemp(path.join(os.tmpdir(), 'chagent-agent-'))
	try {
		const schemaPath = path.join(directory, 'schema.json')
		const outputPath = path.join(directory, 'response.json')
		await writeFile(schemaPath, responseJsonSchema)
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
				settings.model ?? defaultModels.codex,
				'--config',
				`model_reasoning_effort=${JSON.stringify(settings.effort)}`,
				'--config',
				'features.shell_tool=true',
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
				cwd: repositoryRoot,
				input: prompt(request),
				signal: settings.signal,
				timeoutMs: settings.timeoutMs,
			},
		)
		return JSON.parse(await readFile(outputPath, 'utf8'))
	} finally {
		await rm(directory, { force: true, recursive: true })
	}
}

async function runClaude(request: GenerationRequest): Promise<unknown> {
	const { repositoryRoot, settings } = request
	const result = await runCommand(
		'claude',
		[
			'--print',
			'--output-format',
			'json',
			'--json-schema',
			responseJsonSchema,
			'--tools',
			'Read,Glob,Grep,Bash',
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
			settings.model ?? defaultModels.claude,
			'--effort',
			settings.effort,
		],
		{
			allowFailure: true,
			cwd: repositoryRoot,
			input: prompt(request),
			signal: settings.signal,
			timeoutMs: settings.timeoutMs,
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

	return envelope.structured_output
}

const runners: Record<AgentName, (request: GenerationRequest) => Promise<unknown>> = {
	claude: runClaude,
	codex: runCodex,
}

/** Create an adapter for an installed CLI using its existing authentication. */
export function createAgent(name: AgentName): AgentAdapter {
	return {
		cacheKey: `${name}:${defaultModels[name]}`,
		async generate(request) {
			// Every adapter's response, including this one, is validated by the caller.
			return (await runners[name](request)) as GenerationResponse
		},
		name,
	}
}
