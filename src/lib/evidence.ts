import path from 'node:path'
import { z } from 'zod'
import type { Evidence, PackageInfo, Release, Repository } from './types'
import { log } from './log'
import { git, readBlobs, runCommand } from './process'
import { isVersionOnlyEdit, localDate, LOCKFILE_PATH, manifestAt } from './repository'

const COMMIT_MARKER = '\u{1}'
const GENERATED_DIRECTORY = /^(?:build|changelog|coverage|dist)(?:\/|$)/iv
const GENERATED_ANYWHERE = /(?:^|\/)(?:changelog(?:\.md)?$|node_modules(?:\/|$))/iv

/**
 * Generated output lives at the top of a package, so `packages/build` and
 * `src/dist` remain source. Lockfiles record resolved versions, not declared
 * dependency ranges.
 */
function ignored(file: string, packages: PackageInfo[]): boolean {
	// Packages are sorted by directory, so the last match is the most deeply nested owner.
	const owner = packages.findLast(({ directory }) => file.startsWith(`${directory}/`))
	const relative = owner === undefined ? file : file.slice(owner.directory.length + 1)
	return (
		LOCKFILE_PATH.test(file) || GENERATED_ANYWHERE.test(file) || GENERATED_DIRECTORY.test(relative)
	)
}

async function scopes(repository: Repository, pkg: PackageInfo, ref: string): Promise<string[]> {
	if (pkg.directory === '.') {
		return ['.']
	}

	const directories = new Set([pkg.directory])
	const visit = async (current: PackageInfo) => {
		const manifest = await manifestAt(repository.root, current.directory, ref)
		const dependencies = Object.keys({
			...manifest?.dependencies,
			...manifest?.peerDependencies,
			...manifest?.optionalDependencies,
		})
		for (const name of dependencies) {
			const dependency = repository.packages.find((candidate) => candidate.name === name)
			if (!dependency || directories.has(dependency.directory)) {
				continue
			}

			directories.add(dependency.directory)
			await visit(dependency)
		}
	}

	await visit(pkg)
	return [...directories]
}

function isManifest(file: string): boolean {
	return path.posix.basename(file) === 'package.json'
}

function manifestObjects(files: string[], before: string, after: string): string[] {
	return files.flatMap((file) =>
		isManifest(file) ? [`${before}:${file}`, `${after}:${file}`] : [],
	)
}

function hasSourceChanges(files: string[], commit: string, blobs: Map<string, string>): boolean {
	return files.some(
		(file) =>
			!isManifest(file) ||
			!isVersionOnlyEdit(blobs.get(`${commit}^:${file}`), blobs.get(`${commit}:${file}`)),
	)
}

type CommitRecord = { files: string[]; id: string; message: string }

/** Read commits and their changed files from one process. */
async function commitsInRange(
	root: string,
	range: string,
	paths: string[],
): Promise<CommitRecord[]> {
	const output = await git(root, [
		'-c',
		'log.diffMerges=separate',
		'-c',
		'log.showRoot=true',
		'log',
		'--no-show-signature',
		'--no-renames',
		'-m',
		'--name-only',
		'-z',
		'--format=%x01%H%x00%B',
		range,
		'--',
		...paths,
	])
	// Each record is a marked ID, the message, then file names; merges repeat per parent.
	const commits = new Map<string, CommitRecord>()
	const tokens = output.split('\0')
	let current: CommitRecord | undefined
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!
		if (token.startsWith(COMMIT_MARKER)) {
			const id = token.slice(COMMIT_MARKER.length)
			index += 1
			current = commits.get(id) ?? { files: [], id, message: tokens[index]!.trimEnd() }
			commits.set(id, current)
		} else if (current !== undefined && token !== '') {
			const file = token.startsWith('\n') ? token.slice(1) : token
			if (!current.files.includes(file)) {
				current.files.push(file)
			}
		}
	}

	return commits.values().toArray()
}

/** Collect source changes, excluding generated notes and release-only commits. */
export async function collectEvidence(
	repository: Repository,
	pkg: PackageInfo,
	release: Release,
	excludeDirectories: string[] = [],
): Promise<Evidence[]> {
	const { packages, root } = repository
	const directories = await scopes(repository, pkg, release.ref)
	const paths = [
		...directories.map((directory) => `:(literal)${directory}`),
		...excludeDirectories.map((directory) => `:(exclude,literal)${directory}`),
	]
	const range =
		release.previousRef === undefined ? release.ref : `${release.previousRef}..${release.ref}`
	const from = release.previousRef ?? (await git(root, ['hash-object', '-t', 'tree', '--stdin']))
	const changedOutput = await git(root, [
		'diff',
		'--no-ext-diff',
		'--no-textconv',
		'--name-only',
		'-z',
		'--no-renames',
		from,
		release.ref,
		'--',
		...paths,
	])
	const candidates = changedOutput
		.split('\0')
		.filter((file) => file !== '' && !ignored(file, packages))
	const rangeBlobs = await readBlobs(root, manifestObjects(candidates, from, release.ref))
	const changed = new Set(
		candidates.filter(
			(file) =>
				!isManifest(file) ||
				!isVersionOnlyEdit(
					rangeBlobs.get(`${from}:${file}`),
					rangeBlobs.get(`${release.ref}:${file}`),
				),
		),
	)
	if (changed.size === 0) {
		return []
	}

	const commits = await commitsInRange(root, range, paths)
	const sourceCommits = commits.map((item) => ({
		...item,
		files: item.files.filter((file) => !ignored(file, packages)),
	}))
	const commitBlobs = await readBlobs(
		root,
		sourceCommits.flatMap(({ files, id }) => manifestObjects(files, `${id}^`, id)),
	)
	const evidence: Evidence[] = sourceCommits
		.filter(
			({ files, id }) =>
				files.some((file) => changed.has(file)) && hasSourceChanges(files, id, commitBlobs),
		)
		.map(({ files, id, message }) => ({
			id,
			kind: 'commit',
			text: `${message}\nFiles: ${files.join(', ')}`,
		}))

	if (release.pending === true) {
		const file = path.posix.join(pkg.directory, 'package.json')
		const diff = await git(root, [
			'diff',
			'--no-ext-diff',
			'--no-textconv',
			repository.head,
			'--',
			`:(literal)${file}`,
		])
		if (diff !== '') {
			evidence.push({ id: `manifest:${file}`, kind: 'manifest', text: diff })
		}
	}

	if (evidence.length > 0) {
		evidence.unshift({
			id: `range:${from}..${release.ref}`,
			kind: 'range',
			text: `Research the complete Git range ${range} using git log, git diff, git show, and git ls-tree. The supplied commits are a starting point, not a complete description of changes. Follow the scope and exclusions in repository.`,
		})
	}

	return evidence
}

function githubUnavailable(error: unknown): string {
	return `GitHub enrichment unavailable; using Git evidence. ${error instanceof Error ? error.message : String(error)}`
}

/**
 * Read release dates only, keeping generated release bodies out of agent
 * inputs.
 *
 * @returns Whether GitHub could be reached, so later lookups can be skipped.
 */
export async function enrichReleaseDates(
	repository: Repository,
	diagnostics: string[],
	signal?: AbortSignal,
): Promise<boolean> {
	if (repository.github === undefined || repository.tags.length === 0) {
		return true
	}

	try {
		const result = await runCommand(
			'gh',
			[
				'api',
				'--paginate',
				`repos/${repository.github}/releases`,
				'--jq',
				'.[] | {tag_name, published_at, draft}',
			],
			{ cwd: repository.root, signal, timeoutMs: 15_000 },
		)
		for (const line of result.stdout.split('\n')) {
			if (line === '') {
				continue
			}

			const value: unknown = JSON.parse(line)
			if (
				typeof value !== 'object' ||
				value === null ||
				!('tag_name' in value) ||
				!('published_at' in value) ||
				typeof value.published_at !== 'string' ||
				!('draft' in value) ||
				value.draft !== false
			) {
				continue
			}

			const tag = repository.tags.find((item) => item.name === value.tag_name)
			if (tag && !Number.isNaN(Date.parse(value.published_at))) {
				tag.date = localDate(new Date(value.published_at))
			}
		}

		return true
	} catch (error) {
		signal?.throwIfAborted()
		diagnostics.push(githubUnavailable(error))
		return false
	}
}

const associatedPullsSchema = z.object({
	data: z.object({
		repository: z.record(
			z.string(),
			z
				.object({
					associatedPullRequests: z.object({
						nodes: z.array(
							z
								.object({
									body: z.string(),
									mergedAt: z.string().nullable(),
									number: z.number(),
									title: z.string(),
									url: z.string(),
								})
								.nullable(),
						),
						pageInfo: z.object({ endCursor: z.string().nullable(), hasNextPage: z.boolean() }),
					}),
				})
				.nullable(),
		),
	}),
})

type PullLookup = { commit: string; cursor?: string }

function recordPulls(
	pulls: Map<number, Evidence>,
	nodes: NonNullable<
		z.infer<typeof associatedPullsSchema>['data']['repository'][string]
	>['associatedPullRequests']['nodes'],
	commit: string,
): void {
	for (const pull of nodes) {
		if (typeof pull?.mergedAt !== 'string') {
			continue
		}

		const previous = pulls.get(pull.number)
		pulls.set(pull.number, {
			commits: [...new Set([...(previous?.commits ?? []), commit])],
			id: `pr:${pull.number}`,
			kind: 'pull-request',
			text: JSON.stringify(pull),
		})
	}
}

async function associatedPulls(repository: Repository, batch: PullLookup[], signal?: AbortSignal) {
	const [owner, name] = repository.github!.split('/', 2)
	const fields = batch
		.map(
			(item, index) => `c${index}: object(oid: ${JSON.stringify(item.commit)}) {
		... on Commit { associatedPullRequests(first: 100${item.cursor === undefined ? '' : `, after: ${JSON.stringify(item.cursor)}`}) {
			nodes { number title body url mergedAt }
			pageInfo { hasNextPage endCursor }
		} }
	}`,
		)
		.join('\n')
	const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`
	const result = await runCommand('gh', ['api', 'graphql', '--input', '-'], {
		cwd: repository.root,
		input: JSON.stringify({ query, variables: { name, owner } }),
		signal,
		timeoutMs: 15_000,
	})
	return associatedPullsSchema.parse(JSON.parse(result.stdout)).data.repository
}

/**
 * Add PR context in batches of commits; release-note bodies are never
 * requested.
 */
export async function enrichWithGithub(
	repository: Repository,
	evidence: Evidence[],
	diagnostics: string[],
	signal?: AbortSignal,
): Promise<Evidence[]> {
	if (repository.github === undefined) {
		return evidence
	}

	const pulls = new Map<number, Evidence>()
	const commits = new Set(evidence.filter((item) => item.kind === 'commit').map((item) => item.id))
	const pending: PullLookup[] = Array.from(commits, (commit) => ({ commit }))
	try {
		while (pending.length > 0) {
			signal?.throwIfAborted()
			const batch = pending.splice(0, 25)
			const result = await associatedPulls(repository, batch, signal)
			for (const [index, item] of batch.entries()) {
				const connection = result[`c${index}`]?.associatedPullRequests
				if (connection === undefined) {
					// Local release commits may not have been pushed to GitHub yet.
					continue
				}

				recordPulls(pulls, connection.nodes, item.commit)

				if (connection.pageInfo.hasNextPage && connection.pageInfo.endCursor !== null) {
					pending.push({ commit: item.commit, cursor: connection.pageInfo.endCursor })
				}
			}
		}
	} catch (error) {
		signal?.throwIfAborted()
		diagnostics.push(githubUnavailable(error))
	}

	log.debug(`Found ${pulls.size} merged pull requests for ${commits.size} commits.`)
	return [...evidence, ...pulls.values()]
}
