import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { git, runCommand } from './process'
import { readOptional } from './repository'
import { categories } from './types'

const COMMIT_ID = /^[\da-f]{7,64}$/iv
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

function validateDescriptions(changes: Change[], id: string): Change[] {
	return changes.map((change) => {
		const description = normalizeDescription(change.description)
		if (
			description === '' ||
			CONTROL_CHARACTERS.test(description) ||
			HEADING.test(description) ||
			description.includes('<!--')
		) {
			throw new Error(
				`Agent output for ${id} has an empty description, heading, or hidden markup: ${JSON.stringify(change.description)}.`,
			)
		}

		return { ...change, description }
	})
}

/**
 * Validate structure, completeness, and release identity before accepting any
 * adapter's output. Citations are checked separately, by `verifyCitations`.
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
		changes: validateDescriptions(changes, id),
		id,
	}))
}

/** List every commit in a release's range. */
async function rangeCommits(root: string, { repository }: ReleaseRequest): Promise<string[]> {
	const { from, to } = repository
	const commits = await git(root, ['rev-list', from === undefined ? to : `${from}..${to}`])
	return commits.split('\n')
}

async function verifyChanges(
	root: string,
	release: ReleaseRequest,
	changes: Change[],
): Promise<Change[]> {
	const supplied = new Set(release.evidence.map((item) => item.id))
	// Read lazily, since agents mostly cite what they were given.
	let commits: string[] | undefined
	const verified: Change[] = []
	for (const change of changes) {
		const sources = new Set<string>()
		for (const source of change.sources) {
			if (supplied.has(source)) {
				sources.add(source)
			} else if (COMMIT_ID.test(source)) {
				commits ??= await rangeCommits(root, release)
				const matches = commits.filter((commit) => commit.startsWith(source.toLowerCase()))
				if (matches.length === 1) {
					sources.add(matches[0]!)
				}
			}
		}

		if (sources.size === 0) {
			throw new Error(
				`Agent output for ${release.id} cites no supplied evidence or commit in its range: ${change.sources.join(', ')}. Cite an evidence ID supplied for that release, or the ID of a commit within its range.`,
			)
		}

		verified.push({ ...change, sources: [...sources] })
	}

	return verified
}

/**
 * Check citations against Git instead of trusting them. A change may cite
 * evidence supplied for its release or any commit within that release's range,
 * which lets an agent cite what its own research found. Abbreviated commit IDs
 * are completed, and sources that hold up are kept when others do not. Pass the
 * requested releases with their complete evidence.
 *
 * @throws {Error} When a change is left without a source.
 */
export async function verifyCitations(
	root: string,
	changeSets: ChangeSet[],
	releases: ReleaseRequest[],
): Promise<ChangeSet[]> {
	const requested = new Map(releases.map((release) => [release.id, release]))
	const verified: ChangeSet[] = []
	for (const { changes, id } of changeSets) {
		verified.push({ changes: await verifyChanges(root, requested.get(id)!, changes), id })
	}

	return verified
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
		const output = await readOptional(outputPath)
		if (output === undefined) {
			throw new Error('Codex exited without writing a final response.')
		}

		return parseResponse(output)
	} finally {
		await rm(directory, { force: true, recursive: true })
	}
}

/**
 * Parse a final message. Text that is not JSON is returned as is, so validation
 * rejects it and the session gets its correction request.
 */
function parseResponse(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return text
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

	const parsed = z.record(z.string(), z.unknown()).safeParse(parseResponse(result.stdout))
	if (!parsed.success) {
		throw new Error(
			`Claude returned output without a JSON result: ${result.stdout.trim().slice(-500)}`,
		)
	}

	const envelope = parsed.data
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
