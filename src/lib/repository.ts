import { glob, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import semver from 'semver'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Config, PackageInfo, Release, ReleaseContext, Repository } from './types'
import { log } from './log'
import { git, runCommand } from './process'

const GITHUB_REMOTE = /github\.com[:\/]([^\/]+\/[^\/]+?)(?:\.git)?$/v

const manifestSchema = z.object({
	dependencies: z.record(z.string(), z.string()).optional(),
	engines: z.object({ node: z.string().optional() }).optional(),
	name: z.string().optional(),
	optionalDependencies: z.record(z.string(), z.string()).optional(),
	peerDependencies: z.record(z.string(), z.string()).optional(),
	version: z.string().optional(),
	workspaces: z
		.union([z.array(z.string()), z.object({ packages: z.array(z.string()) })])
		.optional(),
})

type Manifest = z.infer<typeof manifestSchema>

/** Read an optional UTF-8 file, distinguishing absence from other I/O failures. */
export async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, 'utf8')
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return undefined
		}

		throw error
	}
}

function parseManifest(text: string, label: string): Manifest {
	try {
		return manifestSchema.parse(JSON.parse(text))
	} catch (error) {
		throw new Error(
			`Cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		)
	}
}

/**
 * Read package metadata from a committed snapshot, never from generated notes.
 * History can contain broken manifests, so an unreadable one counts as absent.
 */
export async function manifestAt(
	root: string,
	directory: string,
	ref: string,
): Promise<Manifest | undefined> {
	const object = `${ref}:${directory === '.' ? '' : directory + '/'}package.json`
	const text = await git(root, ['show', object], true)
	if (text === '') {
		return undefined
	}

	try {
		return parseManifest(text, object)
	} catch (error) {
		log.warn(
			`Ignoring a historical manifest. ${error instanceof Error ? error.message : String(error)}`,
		)
		return undefined
	}
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	try {
		return z.record(z.string(), z.unknown()).safeParse(JSON.parse(text)).data
	} catch {
		// Invalid JSON is ordinary source content, such as a parser's test fixture.
		return undefined
	}
}

/** Recognize release bookkeeping without dropping meaningful manifest changes. */
export async function isVersionOnlyChange(
	root: string,
	file: string,
	beforeRef: string,
	afterRef: string,
): Promise<boolean> {
	const oldValue = parseJsonObject(await git(root, ['show', `${beforeRef}:${file}`], true))
	const newValue = parseJsonObject(await git(root, ['show', `${afterRef}:${file}`], true))
	return (
		oldValue !== undefined &&
		newValue !== undefined &&
		isDeepStrictEqual({ ...oldValue, version: undefined }, { ...newValue, version: undefined })
	)
}

/**
 * Discover a complete Git checkout and its explicitly declared workspace
 * packages.
 */
export async function inspectRepository(
	cwd: string,
	config: Pick<Config, 'exclude' | 'packages'> = {},
): Promise<Repository> {
	const gitRoot = await git(cwd, ['rev-parse', '--show-toplevel'])
	const root = await realpath(gitRoot)
	if ((await git(root, ['rev-parse', '--is-shallow-repository'])) === 'true') {
		throw new Error(
			'Release history is incomplete in this shallow checkout. Fetch the full history and tags before running chagent.',
		)
	}

	const head = await git(root, ['rev-parse', '--verify', 'HEAD'])
	const gitDirectory = await git(root, ['rev-parse', '--absolute-git-dir'])
	const rootText = await readOptional(path.join(root, 'package.json'))
	const manifest = rootText === undefined ? undefined : parseManifest(rootText, 'package.json')
	const packages = await workspacePackages(root, manifest, config)

	const tagText = await git(root, [
		'for-each-ref',
		'--merged',
		head,
		'--format=%(refname:strip=2)',
		'refs/tags',
	])
	const tags: Repository['tags'] = []
	for (const name of tagText.split('\n')) {
		if (name === '') {
			continue
		}

		const commit = await git(root, ['rev-parse', 'refs/tags/' + name + '^{commit}'], true)
		if (commit === '') {
			continue
		}

		const date = await git(root, ['log', '-1', '--format=%cs', commit])
		tags.push({ commit, date, name })
	}

	const remote = await git(root, ['remote', 'get-url', 'origin'], true)
	const github = GITHUB_REMOTE.exec(remote)?.[1]
	return {
		gitDirectory,
		github,
		head,
		packages,
		root,
		rootPackage: packageInfo(manifest, '.', path.basename(root)),
		tags,
	}
}

function packageInfo(
	manifest: Manifest | undefined,
	directory: string,
	fallback?: string,
): PackageInfo {
	return {
		dependencies: Object.keys({
			...manifest?.dependencies,
			...manifest?.peerDependencies,
			...manifest?.optionalDependencies,
		}),
		directory,
		name: manifest?.name ?? fallback ?? directory,
		node: manifest?.engines?.node,
		version: manifest?.version,
	}
}

function tagVersion(tag: string, pkg: PackageInfo, patterns?: string[]): string | undefined {
	const templates = patterns ?? ['{name}@{version}', '{name}/v{version}', 'v{version}', '{version}']
	for (const pattern of templates) {
		const expanded = pattern.replaceAll('{name}', () => pkg.name)
		const [prefix, suffix = ''] = expanded.split('{version}', 2)
		if (prefix === undefined || !tag.startsWith(prefix) || !tag.endsWith(suffix)) {
			continue
		}

		const value = tag.slice(prefix.length, suffix === '' ? undefined : -suffix.length)
		const version = semver.valid(value)
		if (version !== null) {
			return version
		}
	}

	return undefined
}

/** Resolve release intervals from reachable tags and locally bumped manifests. */
export async function resolveReleases(
	repository: Repository,
	pkg: PackageInfo,
	config: Pick<Config, 'tagPatterns'>,
	context?: ReleaseContext,
): Promise<Release[]> {
	const releases = await taggedReleases(repository, pkg, config)

	releases.sort((a, b) => semver.compare(a.version, b.version))
	for (let index = 1; index < releases.length; index++) {
		const current = releases[index]!
		const previous = await precedingRelease(repository.root, releases.slice(0, index), current.ref)
		current.previousRef = previous?.ref
		current.previousTag = previous?.tag
	}

	const latest = releases.at(-1)
	const currentVersion = pkg.version ?? (pkg.directory === '.' ? context?.version : undefined)
	const pending = await isPendingRelease(repository, pkg, latest, context)

	if (pending && currentVersion !== undefined) {
		releases.push({
			date: context?.date ?? new Date().toISOString().slice(0, 10),
			pending: true,
			previousRef: latest?.ref,
			previousTag: latest?.tag,
			ref: repository.head,
			tag: context?.tag,
			version: currentVersion,
		})
	} else if (latest?.ref !== repository.head) {
		releases.push({
			previousRef: latest?.ref,
			previousTag: latest?.tag,
			ref: repository.head,
			version: 'Unreleased',
		})
	}

	return releases
}

/**
 * Detect stable minor/patch releases that raised the minimum Node.js
 * requirement.
 */
export async function hasNodeException(
	repository: Repository,
	pkg: PackageInfo,
	releases: Release[],
): Promise<boolean> {
	let previous: undefined | { node: string; version: string }
	for (const release of releases) {
		if (
			release.version === 'Unreleased' ||
			release.pending === true ||
			semver.prerelease(release.version) !== null
		) {
			continue
		}

		const manifest = await manifestAt(repository.root, pkg.directory, release.ref)
		const node = manifest?.engines?.node
		if (node === undefined || semver.validRange(node) === null) {
			previous = undefined
			continue
		}

		if (
			previous &&
			semver.major(release.version) > 0 &&
			semver.major(previous.version) === semver.major(release.version)
		) {
			const before = semver.minVersion(previous.node)
			const after = semver.minVersion(node)
			if (before !== null && after !== null && semver.gt(after, before)) {
				return true
			}
		}

		previous = { node, version: release.version }
	}

	return false
}

async function workspacePackages(
	root: string,
	manifest: Manifest | undefined,
	config: Pick<Config, 'exclude' | 'packages'>,
): Promise<PackageInfo[]> {
	let patterns = Array.isArray(manifest?.workspaces)
		? manifest.workspaces
		: (manifest?.workspaces?.packages ?? [])
	const workspaceText = await readOptional(path.join(root, 'pnpm-workspace.yaml'))
	if (workspaceText !== undefined) {
		patterns =
			z.object({ packages: z.array(z.string()).optional() }).parse(parse(workspaceText)).packages ??
			patterns
	}

	patterns = config.packages ?? patterns
	const directories: string[] = []
	const positive = patterns.filter((pattern) => !pattern.startsWith('!'))
	const negative = patterns
		.filter((pattern) => pattern.startsWith('!'))
		.map((pattern) => pattern.slice(1))
	const matches = glob(positive, {
		cwd: root,
		exclude: ['**/node_modules/**', '**/.git/**', ...negative, ...(config.exclude ?? [])],
		withFileTypes: true,
	})
	for await (const entry of matches) {
		if (!entry.isDirectory()) {
			continue
		}

		directories.push(
			path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
		)
	}

	const packages: PackageInfo[] = []
	for (const directory of directories.toSorted()) {
		const absolute = await realpath(path.join(root, directory))
		if (!absolute.startsWith(root + path.sep)) {
			throw new Error(`Workspace package escapes the repository: ${directory}`)
		}

		const text = await readOptional(path.join(root, directory, 'package.json'))
		if (text === undefined && config.packages === undefined) {
			continue
		}

		packages.push(
			packageInfo(
				text === undefined ? undefined : parseManifest(text, `${directory}/package.json`),
				directory,
				path.posix.basename(directory),
			),
		)
	}

	return packages
}

async function taggedReleases(
	repository: Repository,
	pkg: PackageInfo,
	config: Pick<Config, 'tagPatterns'>,
): Promise<Release[]> {
	const releases: Release[] = []
	for (const tag of repository.tags) {
		const version = tagVersion(tag.name, pkg, config.tagPatterns)
		if (version === undefined) {
			continue
		}

		const manifest = await manifestAt(repository.root, pkg.directory, tag.commit)
		if (pkg.directory !== '.') {
			if (manifest?.version !== undefined && semver.valid(manifest.version) !== version) {
				continue
			}

			if (
				manifest === undefined &&
				(await git(repository.root, ['cat-file', '-t', `${tag.commit}:${pkg.directory}`], true)) !==
					'tree'
			) {
				continue
			}
		}

		const existing = releases.find((release) => release.version === version)
		if (existing && existing.ref !== tag.commit) {
			throw new Error(
				`Multiple reachable tags disagree about ${pkg.name} ${version}. Configure tagPatterns to select a release series.`,
			)
		}

		if (existing) {
			continue
		}

		releases.push({ date: tag.date, ref: tag.commit, tag: tag.name, version })
	}

	return releases
}

async function precedingRelease(
	root: string,
	candidates: Release[],
	ref: string,
): Promise<Release | undefined> {
	for (const candidate of candidates.toReversed()) {
		const result = await runCommand('git', ['merge-base', '--is-ancestor', candidate.ref, ref], {
			allowFailure: true,
			cwd: root,
		})
		if (result.code !== 0) {
			continue
		}

		return candidate
	}

	return undefined
}

async function isPendingRelease(
	repository: Repository,
	pkg: PackageInfo,
	latest: Release | undefined,
	context?: ReleaseContext,
): Promise<boolean> {
	const currentVersion = pkg.version ?? (pkg.directory === '.' ? context?.version : undefined)
	const committed = await manifestAt(repository.root, pkg.directory, repository.head)
	const versionChanged = currentVersion !== undefined && currentVersion !== committed?.version
	const parent = await manifestAt(repository.root, pkg.directory, repository.head + '^')
	const committedBump = parent?.version !== undefined && parent.version !== committed?.version
	return (
		currentVersion !== undefined &&
		semver.valid(currentVersion) !== null &&
		(latest === undefined || semver.gt(currentVersion, latest.version)) &&
		(versionChanged || context !== undefined || committedBump)
	)
}
