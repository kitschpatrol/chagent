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
const HEADING = /^#{1,6}\s/v
const LIST_MARKER = /^(?:[\-*]|\d+\.)(?:\s+|$)/v
const WHITESPACE_RUN = /\s+/gv
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

/** Repair formatting mistakes that cannot change what an entry says. */
function normalizeDescription(description: string): string {
	return description.replaceAll(WHITESPACE_RUN, ' ').trim().replace(LIST_MARKER, '')
}

function validateChanges(changes: Change[], release: ReleaseRequest): Change[] {
	const ids = new Set(release.evidence.map((item) => item.id))
	return changes.map((change) => {
		const unknown = change.sources.filter((source) => !ids.has(source))
		if (unknown.length > 0) {
			throw new Error(
				`Agent output for ${release.id} cites evidence that was not supplied: ${unknown.join(', ')}.`,
			)
		}

		const description = normalizeDescription(change.description)
		if (
			description === '' ||
			CONTROL_CHARACTERS.test(description) ||
			HEADING.test(description) ||
			description.includes('<!--')
		) {
			throw new Error(
				`Agent output for ${release.id} has an empty description, heading, or hidden markup: ${JSON.stringify(change.description)}.`,
			)
		}

		return { ...change, description }
	})
}

/**
 * Validate structure, completeness, release identity, and citations before
 * accepting any adapter's output.
 *
 * @returns The change sets, with descriptions normalized.
 */
export function validateResponse(value: unknown, releases: ReleaseRequest[]): ChangeSet[] {
	const response = responseSchema.safeParse(value)
	if (!response.success) {
		throw new Error(
			`Agent output does not match the response format:\n${z.prettifyError(response.error)}`,
			{ cause: response.error },
		)
	}

	const expected = new Map(releases.map((release) => [release.id, release]))
	const ids = response.data.releases.map(({ id }) => id)
	const unexpected = ids.filter((id, index) => !expected.has(id) || ids.indexOf(id) !== index)
	if (unexpected.length > 0) {
		throw new Error(
			`Agent output contains unknown or duplicate release ids: ${unexpected.join(', ')}.`,
		)
	}

	const omitted = expected
		.keys()
		.filter((id) => !ids.includes(id))
		.toArray()
	if (omitted.length > 0) {
		throw new Error(`Agent output omitted requested releases: ${omitted.join(', ')}.`)
	}

	return response.data.releases.map(({ changes, id }) => ({
		changes: validateChanges(changes, expected.get(id)!),
		id,
	}))
}

function prompt({ releases, repair, repositoryRoot }: GenerationRequest): string {
	const correction =
		repair === undefined
			? ''
			: `\n\nYour previous response failed validation: ${repair.error}\nPrevious response (JSON):\n${JSON.stringify(repair.response)}\nReturn the complete corrected JSON object. Keep your previous findings, and repeat only the research the correction needs.`
	return `${instructions}${correction}\n\nInput data (JSON):\n${JSON.stringify({ releases, repositoryRoot })}`
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
				// The response comes from the output file; stdout only streams session events.
				tailStdout: true,
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
