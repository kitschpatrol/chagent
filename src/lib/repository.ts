import { glob, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import semver from 'semver'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Config } from './config'
import type { PackageInfo, Release, ReleaseContext, Repository } from './types'
import { log } from './log'
import { git, isAncestor, readBlobs } from './process'

/** Matches package manager lockfile paths. */
export const LOCKFILE_PATH =
	/(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/v
const TAG_DECORATION = 'tag: refs/tags/'
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

/**
 * Format a release date in local time, matching the date its publisher saw
 * rather than the date in UTC.
 */
export function localDate(date = new Date()): string {
	return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
		.map((part) => String(part).padStart(2, '0'))
		.join('-')
}

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

function manifestObject(directory: string, ref: string): string {
	return `${ref}:${directory === '.' ? '' : directory + '/'}package.json`
}

/**
 * Read package metadata from committed snapshots, never from generated notes.
 * History can contain broken manifests, so an unreadable one counts as absent.
 */
async function manifestsAt(
	root: string,
	directory: string,
	refs: string[],
): Promise<Map<string, Manifest>> {
	const blobs = await readBlobs(
		root,
		refs.map((ref) => manifestObject(directory, ref)),
	)
	const manifests = new Map<string, Manifest>()
	for (const ref of refs) {
		const object = manifestObject(directory, ref)
		const text = blobs.get(object)
		if (text === undefined) {
			continue
		}

		try {
			manifests.set(ref, parseManifest(text, object))
		} catch (error) {
			log.warn(
				`Ignoring a historical manifest. ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	return manifests
}

/** Read package metadata from one committed snapshot. */
export async function manifestAt(
	root: string,
	directory: string,
	ref: string,
): Promise<Manifest | undefined> {
	const manifests = await manifestsAt(root, directory, [ref])
	return manifests.get(ref)
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
export function isVersionOnlyEdit(before: string | undefined, after: string | undefined): boolean {
	const oldValue = before === undefined ? undefined : parseJsonObject(before)
	const newValue = after === undefined ? undefined : parseJsonObject(after)
	return (
		oldValue !== undefined &&
		newValue !== undefined &&
		isDeepStrictEqual({ ...oldValue, version: undefined }, { ...newValue, version: undefined })
	)
}

/** Compare a manifest between two commits. */
export async function isVersionOnlyChange(
	root: string,
	file: string,
	beforeRef: string,
	afterRef: string,
): Promise<boolean> {
	const before = `${beforeRef}:${file}`
	const after = `${afterRef}:${file}`
	const blobs = await readBlobs(root, [before, after])
	return isVersionOnlyEdit(blobs.get(before), blobs.get(after))
}

/** Read every tag reachable from a commit, resolved to its commit and date. */
async function reachableTags(root: string, head: string): Promise<Repository['tags']> {
	const output = await git(root, [
		'log',
		'--no-show-signature',
		'--simplify-by-decoration',
		'--decorate=full',
		'--decorate-refs=refs/tags/',
		'--format=%H%x00%cs%x00%D',
		head,
	])
	const tags: Repository['tags'] = []
	for (const line of output.split('\n')) {
		const [commit = '', date = '', decorations = ''] = line.split('\0', 3)
		for (const decoration of decorations.split(', ')) {
			if (decoration.startsWith(TAG_DECORATION)) {
				tags.push({ commit, date, name: decoration.slice(TAG_DECORATION.length) })
			}
		}
	}

	return tags.toSorted((a, b) => a.name.localeCompare(b.name))
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

	const tags = await reachableTags(root, head)
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
		directory,
		name: manifest?.name ?? fallback ?? directory,
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

/**
 * Predict the tag of a release that is not tagged yet, so its heading can link
 * to it. Follow the previous tag's format, then the first configured pattern,
 * then `v{version}`.
 */
function pendingTag(
	pkg: PackageInfo,
	version: string,
	previous: Release | undefined,
	patterns?: string[],
): string {
	const template =
		previous?.tag?.includes(previous.version) === true
			? previous.tag.replace(previous.version, '{version}')
			: (patterns?.[0] ?? 'v{version}')
	return template.replaceAll('{name}', () => pkg.name).replaceAll('{version}', () => version)
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
			date: context?.date ?? localDate(),
			pending: true,
			previousRef: latest?.ref,
			previousTag: latest?.tag,
			ref: repository.head,
			tag: context?.tag ?? pendingTag(pkg, currentVersion, latest, config.tagPatterns),
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
	const published = releases.filter(
		(release) =>
			release.version !== 'Unreleased' &&
			release.pending !== true &&
			semver.prerelease(release.version) === null,
	)
	const manifests = await manifestsAt(
		repository.root,
		pkg.directory,
		published.map((release) => release.ref),
	)
	let previous: undefined | { node: string; version: string }
	for (const release of published) {
		const node = manifests.get(release.ref)?.engines?.node
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
	const candidates: Array<{ tag: Repository['tags'][number]; version: string }> = []
	for (const tag of repository.tags) {
		const version = tagVersion(tag.name, pkg, config.tagPatterns)
		if (version !== undefined) {
			candidates.push({ tag, version })
		}
	}

	const isRoot = pkg.directory === '.'
	const manifests = isRoot
		? new Map<string, Manifest>()
		: await manifestsAt(
				repository.root,
				pkg.directory,
				candidates.map(({ tag }) => tag.commit),
			)
	const releases: Release[] = []
	for (const { tag, version } of candidates) {
		if (!isRoot) {
			const manifest = manifests.get(tag.commit)
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
		if (await isAncestor(root, candidate.ref, ref)) {
			return candidate
		}
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
