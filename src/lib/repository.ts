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

/**
 * Matches package manager lockfile paths. Excludes npm-shrinkwrap.json, which
 * is published and constrains consumers.
 */
export const LOCKFILE_PATH =
	/(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|deno\.lock|uv\.lock|poetry\.lock|pdm\.lock|Pipfile\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/v
const TAG_DECORATION = 'tag: refs/tags/'
const GITHUB_REMOTE = /github\.com[:\/]([^\/]+\/[^\/]+?)(?:\.git)?$/v
const SHORT_VERSION = /^\d+(?:\.\d+)?$/v

type ParsedVersion = { precision: number; version: string }
type TagCandidate = ParsedVersion & { tag: Repository['tags'][number] }

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

const pnpmWorkspaceSchema = z.object({ packages: z.array(z.string()).optional() }).nullable()

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

async function workingManifest(root: string, directory: string): Promise<Manifest | undefined> {
	const file = path.posix.join(directory, 'package.json')
	const text = await readOptional(path.join(root, file))
	return text === undefined ? undefined : parseManifest(text, file)
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
	config: Pick<Config, 'exclude' | 'packages' | 'skipPackage'> = {},
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

/**
 * Read a version, with how many of its parts are spelled out. Short versions
 * such as `1` or `1.2` name the first release of their series.
 */
export function parseVersion(value: string): ParsedVersion | undefined {
	const version = semver.valid(value)
	if (version !== null) {
		return { precision: 3, version }
	}

	if (!SHORT_VERSION.test(value)) {
		return undefined
	}

	const parts = value.split('.')
	const padded = semver.valid([...parts, '0', '0'].slice(0, 3).join('.'))
	return padded === null ? undefined : { precision: parts.length, version: padded }
}

/** Read the version a tag names for a package, using its tag patterns. */
function tagVersion(tag: string, pkg: PackageInfo, patterns?: string[]): ParsedVersion | undefined {
	const templates = patterns ?? ['{name}@{version}', '{name}/v{version}', 'v{version}', '{version}']
	for (const pattern of templates) {
		const expanded = pattern.replaceAll('{name}', () => pkg.name)
		const [prefix, suffix = ''] = expanded.split('{version}', 2)
		if (prefix === undefined || !tag.startsWith(prefix) || !tag.endsWith(suffix)) {
			continue
		}

		const parsed = parseVersion(
			tag.slice(prefix.length, suffix === '' ? undefined : -suffix.length),
		)
		// Bare numbers are often build or date tags, so default patterns need a v.
		const bareNumber = parsed?.precision === 1 && patterns === undefined && !prefix.endsWith('v')
		if (parsed !== undefined && !bareNumber) {
			return parsed
		}
	}

	return undefined
}

/**
 * Check that a short tag such as `v1` or `v1.2` precedes every more precise tag
 * in its series. Floating tags that follow the latest release fail this check.
 */
async function leadsSeries(
	root: string,
	candidate: TagCandidate,
	candidates: TagCandidate[],
): Promise<boolean> {
	const major = semver.major(candidate.version)
	const minor = semver.minor(candidate.version)
	for (const other of candidates) {
		if (
			other.precision <= candidate.precision ||
			semver.major(other.version) !== major ||
			(candidate.precision === 2 && semver.minor(other.version) !== minor) ||
			semver.lt(other.version, candidate.version)
		) {
			continue
		}

		if (
			other.tag.commit === candidate.tag.commit ||
			!(await isAncestor(root, candidate.tag.commit, other.tag.commit))
		) {
			return false
		}
	}

	return true
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
 * Detect stable minor/patch releases, including one about to be published, that
 * raised the minimum Node.js requirement.
 */
export async function hasNodeException(
	repository: Repository,
	pkg: PackageInfo,
	releases: Release[],
): Promise<boolean> {
	const stable = releases.filter(
		(release) => release.version !== 'Unreleased' && semver.prerelease(release.version) === null,
	)
	const manifests = await manifestsAt(
		repository.root,
		pkg.directory,
		stable.filter((release) => release.pending !== true).map((release) => release.ref),
	)
	// A pending release is published from the working tree, where its version was bumped.
	const pending = stable.some((release) => release.pending === true)
		? await workingManifest(repository.root, pkg.directory)
		: undefined
	let previous: undefined | { node: string; version: string }
	for (const release of stable) {
		const manifest = release.pending === true ? pending : manifests.get(release.ref)
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

/**
 * Read package globs from pnpm-workspace.yaml, which may be empty or hold only
 * settings.
 */
function pnpmWorkspaceGlobs(text: string): string[] | undefined {
	let value: unknown
	try {
		value = parse(text)
	} catch (error) {
		throw new Error(
			`Cannot parse pnpm-workspace.yaml: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		)
	}

	const workspace = pnpmWorkspaceSchema.safeParse(value)
	if (!workspace.success) {
		throw new Error(`Invalid pnpm-workspace.yaml:\n${z.prettifyError(workspace.error)}`, {
			cause: workspace.error,
		})
	}

	return workspace.data?.packages
}

/** Find directories matching globs, as POSIX paths relative to the root. */
async function matchDirectories(
	root: string,
	patterns: string[],
	exclude: string[] = [],
): Promise<string[]> {
	const directories: string[] = []
	const matches = glob(patterns, {
		cwd: root,
		exclude: ['**/node_modules/**', '**/.git/**', ...exclude],
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

	return directories
}

/** Mark the packages that remain boundaries but get no changelog. */
async function markSkipped(
	root: string,
	packages: PackageInfo[],
	patterns: string[],
): Promise<PackageInfo[]> {
	const skipped = new Set<string>()
	for (const pattern of patterns) {
		const directories = await matchDirectories(root, [pattern])
		const matches = directories.filter((directory) =>
			packages.some((pkg) => pkg.directory === directory),
		)
		if (matches.length === 0) {
			throw new Error(
				`skipPackage pattern "${pattern}" matches no workspace package directory. Use a directory glob relative to the repository root, such as "packages/docs"; rootChangelog controls the root changelog.`,
			)
		}

		for (const directory of matches) {
			skipped.add(directory)
		}
	}

	return packages.map((pkg) => (skipped.has(pkg.directory) ? { ...pkg, skipped: true } : pkg))
}

async function workspacePackages(
	root: string,
	manifest: Manifest | undefined,
	config: Pick<Config, 'exclude' | 'packages' | 'skipPackage'>,
): Promise<PackageInfo[]> {
	let patterns = Array.isArray(manifest?.workspaces)
		? manifest.workspaces
		: (manifest?.workspaces?.packages ?? [])
	const workspaceText = await readOptional(path.join(root, 'pnpm-workspace.yaml'))
	if (workspaceText !== undefined) {
		patterns = pnpmWorkspaceGlobs(workspaceText) ?? patterns
	}

	patterns = config.packages ?? patterns
	const positive = patterns.filter((pattern) => !pattern.startsWith('!'))
	const negative = patterns
		.filter((pattern) => pattern.startsWith('!'))
		.map((pattern) => pattern.slice(1))
	const directories = await matchDirectories(root, positive, [
		...negative,
		...(config.exclude ?? []),
	])

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

	return markSkipped(root, packages, config.skipPackage ?? [])
}

/** Select the workspace packages that get changelogs of their own. */
export function describedPackages(repository: Repository): PackageInfo[] {
	return repository.packages.filter((pkg) => pkg.skipped !== true)
}

async function taggedReleases(
	repository: Repository,
	pkg: PackageInfo,
	config: Pick<Config, 'tagPatterns'>,
): Promise<Release[]> {
	const candidates: TagCandidate[] = []
	for (const tag of repository.tags) {
		const match = tagVersion(tag.name, pkg, config.tagPatterns)
		if (match !== undefined) {
			candidates.push({ ...match, tag })
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
	const owned: TagCandidate[] = []
	for (const candidate of candidates) {
		if (!isRoot) {
			const manifest = manifests.get(candidate.tag.commit)
			if (manifest?.version !== undefined && semver.valid(manifest.version) !== candidate.version) {
				continue
			}

			if (
				manifest === undefined &&
				(await git(
					repository.root,
					['cat-file', '-t', `${candidate.tag.commit}:${pkg.directory}`],
					true,
				)) !== 'tree'
			) {
				continue
			}
		}

		owned.push(candidate)
	}

	const releases: Release[] = []
	for (const candidate of owned) {
		if (candidate.precision < 3 && !(await leadsSeries(repository.root, candidate, owned))) {
			continue
		}

		const { tag, version } = candidate
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
