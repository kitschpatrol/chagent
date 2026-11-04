import path from 'node:path'
import type { Evidence, PackageInfo, Release, Repository } from './types'
import { git, runCommand } from './process'

const GENERATED_PATH = /(?:^|\/)(?:changelog(?:\.md)?|node_modules|dist|build|coverage)(?:\/|$)/iv
const LOCKFILE_PATH = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/v

function ignored(file: string): boolean {
	return GENERATED_PATH.test(file) || LOCKFILE_PATH.test(file)
}

function scopes(repository: Repository, pkg: PackageInfo): string[] {
	if (pkg.directory === '.') {
		return ['.']
	}

	const directories = new Set([pkg.directory])
	const visit = (current: PackageInfo) => {
		for (const name of current.dependencies) {
			const dependency = repository.packages.find((candidate) => candidate.name === name)
			if (!dependency || directories.has(dependency.directory)) {
				continue
			}

			directories.add(dependency.directory)
			visit(dependency)
		}
	}

	visit(pkg)
	return [...directories]
}

/** Collect source changes, excluding generated notes and release-only commits. */
export async function collectEvidence(
	repository: Repository,
	pkg: PackageInfo,
	release: Release,
	excludeDirectories: string[] = [],
): Promise<Evidence[]> {
	const { root } = repository
	const directories = scopes(repository, pkg)
	const paths = [
		...directories.map((directory) => `:(literal)${directory}`),
		...excludeDirectories.map((directory) => `:(exclude,literal)${directory}`),
	]
	const range =
		release.previousRef === undefined ? release.ref : `${release.previousRef}..${release.ref}`
	const emptyTree = await git(root, ['hash-object', '-t', 'tree', '--stdin'])
	const from = release.previousRef ?? emptyTree
	const awaitedResult1 = await git(root, [
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
	const changed = awaitedResult1.split('\0').filter((file) => file !== '' && !ignored(file))
	if (changed.length === 0) {
		return []
	}

	const evidence: Evidence[] = []
	const awaitedResult2 = await git(root, ['log', '--format=%H', range, '--', ...paths])
	const commits = awaitedResult2.split('\n').filter(Boolean)
	for (const commit of commits) {
		const awaitedResult3 = await git(root, [
			'diff-tree',
			'--root',
			'-m',
			'--no-commit-id',
			'--name-only',
			'-r',
			'-z',
			commit,
			'--',
			...paths,
		])
		const files = awaitedResult3.split('\0').filter((file) => file !== '' && !ignored(file))
		if (files.every((file) => !changed.includes(file))) {
			continue
		}

		const message = await git(root, ['show', '-s', '--format=%B', commit])
		evidence.push({ id: commit, kind: 'commit', text: `${message}\nFiles: ${files.join(', ')}` })
	}

	for (const file of changed) {
		const diff = await git(root, [
			'diff',
			'--no-ext-diff',
			'--no-textconv',
			'--unified=3',
			from,
			release.ref,
			'--',
			`:(literal)${file}`,
		])
		evidence.push({ id: `diff:${file}`, kind: 'diff', text: diff })
	}

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

	return evidence
}

/**
 * Read release dates only, keeping generated release bodies out of agent
 * inputs.
 */
export async function enrichReleaseDates(
	repository: Repository,
	diagnostics: string[],
	signal?: AbortSignal,
): Promise<void> {
	if (repository.github === undefined || repository.tags.length === 0) {
		return
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
				tag.date = new Date(value.published_at).toISOString().slice(0, 10)
			}
		}
	} catch (error) {
		signal?.throwIfAborted()
		diagnostics.push(
			`GitHub enrichment unavailable; using Git evidence. ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

/**
 * Add PR context by commit association; release-note bodies are never
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

	const extra: Evidence[] = []
	const seen = new Set<number>()
	try {
		for (const item of evidence) {
			if (item.kind !== 'commit') {
				continue
			}

			const result = await runCommand(
				'gh',
				[
					'api',
					'--paginate',
					`repos/${repository.github}/commits/${item.id}/pulls`,
					'--jq',
					'.[] | {number, title, body, html_url, merged_at}',
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
					!('number' in value) ||
					typeof value.number !== 'number' ||
					!('merged_at' in value) ||
					value.merged_at === null ||
					seen.has(value.number)
				) {
					continue
				}

				seen.add(value.number)
				extra.push({
					id: `pr:${value.number}`,
					kind: 'pull-request',
					text: `Associated commit: ${item.id}\n${line}`,
				})
			}
		}
	} catch (error) {
		signal?.throwIfAborted()
		const message = `GitHub enrichment unavailable; using Git evidence. ${error instanceof Error ? error.message : String(error)}`
		if (diagnostics.every((item) => !item.startsWith('GitHub enrichment unavailable'))) {
			diagnostics.push(message)
		}
	}

	return [...evidence, ...extra]
}
