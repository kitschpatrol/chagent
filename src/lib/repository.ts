import { glob, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Config, PackageInfo, Release, ReleaseContext, Repository } from './types'
import { git, runCommand } from './process'

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

/** Read package metadata from a committed snapshot, never from generated notes. */
export async function manifestAt(root: string, directory: string, ref: string) {
	const text = await git(
		root,
		['show', `${ref}:${directory === '.' ? '' : directory + '/'}package.json`],
		true,
	)
	return text === '' ? undefined : manifestSchema.parse(JSON.parse(text))
}

/** Discover a complete Git checkout and its explicitly declared workspace
packages. */
export async function inspectRepository(cwd: string, config: Config = {}): Promise<Repository> {
	const root = await git(cwd, ['rev-parse', '--show-toplevel'])
	if ((await git(root, ['rev-parse', '--is-shallow-repository'])) === 'true') {
		throw new Error(
			'Release history is incomplete in this shallow checkout. Fetch the full history and tags before running chagent.',
		)
	}

	const head = await git(root, ['rev-parse', '--verify', 'HEAD'])
	const gitDirectory = await git(root, ['rev-parse', '--absolute-git-dir'])
	const rootText = await readOptional(path.join(root, 'package.json'))
	const manifest = rootText === undefined ? undefined : manifestSchema.parse(JSON.parse(rootText))
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
	const negative = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1))
	for await (const entry of glob(positive, { cwd: root, withFileTypes: true, exclude: ['**/node_modules/**', '**/.git/**', ...negative, ...(config.exclude ?? [])] })) {
		if (entry.isDirectory()) {
			directories.push(path.relative(root, path.join(entry.parentPath, entry.name)))
		}
	}
	const packages: PackageInfo[] = []
	for (const directory of directories.toSorted()) {
		const absolute = await realpath(path.join(root, directory))
		if (!absolute.startsWith(root + path.sep)) {
			throw new Error(`Workspace package escapes the repository: ${directory}`)
		}

		const text = await readOptional(path.join(root, directory, 'package.json'))
		if (text !== undefined) {
			packages.push(packageInfo(manifestSchema.parse(JSON.parse(text)), directory))
		}
	}

	const tagText = await git(root, [
		'for-each-ref',
		'--merged',
		head,
		'--format=%(refname:short)',
		'refs/tags',
	])
	const tags: Repository['tags'] = []
	for (const name of tagText.split('\n')) {
		if (name === '') {
			continue
		}
		const commit = await git(root, ['rev-parse', name + '^{commit}'], true)
		if (commit !== '') {
			const date = await git(root, ['log', '-1', '--format=%cs', commit])
			tags.push({ commit, date, name })
		}
	}

	const remote = await git(root, ['remote', 'get-url', 'origin'], true)
	const github = /github\.com[:\/]([^\/]+\/[^\/]+?)(?:\.git)?$/v.exec(remote)?.[1]
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
	manifest: undefined | z.infer<typeof manifestSchema>,
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
	const templates = patterns ?? [
		'{name}@{version}',
		'{name}/v{version}',
		'v{version}',
		'{version}',
	]
	for (const pattern of templates) {
		const expanded = pattern.replaceAll('{name}', () => pkg.name)
		const [prefix, suffix = ''] = expanded.split('{version}', 2)
		if (prefix !== undefined && tag.startsWith(prefix) && tag.endsWith(suffix)) {
			const value = tag.slice(prefix.length, suffix === '' ? undefined : -suffix.length)
			const version = semver.valid(value)
			if (version !== null) {
				return version
			}
		}
	}

	return undefined
}

/** Resolve release intervals from reachable tags and locally bumped manifests. */
export async function resolveReleases(
	repository: Repository,
	pkg: PackageInfo,
	config: Config,
	context?: ReleaseContext,
): Promise<Release[]> {
	const releases: Release[] = []
	for (const tag of repository.tags) {
		const version = tagVersion(tag.name, pkg, config.tagPatterns)
		if (version === undefined) {
			continue
		}

		const manifest = await manifestAt(repository.root, pkg.directory, tag.commit)
		if (
			(pkg.directory !== '.' && manifest === undefined) ||
			(manifest?.version !== undefined && semver.valid(manifest.version) !== version)
		) {
			continue
		}

		const existing = releases.find((release) => release.version === version)
		if (existing && existing.ref !== tag.commit) {
			throw new Error(
				`Multiple reachable tags disagree about ${pkg.name} ${version}. Configure tagPatterns to select a release series.`,
			)
		}

		if (!existing) {
			releases.push({ date: tag.date, ref: tag.commit, tag: tag.name, version })
		}
	}

	releases.sort((a, b) => semver.compare(a.version, b.version))
	for (let index = 1; index < releases.length; index++) {
		const previous = releases[index - 1]!
		const current = releases[index]!
		const result = await runCommand(
			'git',
			['merge-base', '--is-ancestor', previous.ref, current.ref],
			{ allowFailure: true, cwd: repository.root },
		)
		if (result.code !== 0) {
			throw new Error(
				`Release tags for ${pkg.name} do not form one ancestry chain (${previous.tag}, ${current.tag}). Configure tagPatterns for this release line.`,
			)
		}

		current.previousRef = previous.ref
		current.previousTag = previous.tag
	}

	const latest = releases.at(-1)
	const currentVersion = pkg.version ?? (pkg.directory === '.' ? context?.version : undefined)
	const committed = await manifestAt(repository.root, pkg.directory, repository.head)
	const versionChanged = currentVersion !== undefined && currentVersion !== committed?.version
	const pending =
		currentVersion !== undefined &&
		semver.valid(currentVersion) !== null &&
		(latest === undefined || semver.gt(currentVersion, latest.version)) &&
		(versionChanged || context !== undefined)
	if (pending) {
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

/** Detect stable minor/patch releases that raised the minimum Node.js
requirement. */
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
