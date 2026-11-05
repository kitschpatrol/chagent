import type { Config, ResolvedConfig } from './config'

export const categories = [
	'Added',
	'Changed',
	'Deprecated',
	'Removed',
	'Fixed',
	'Security',
	'Documentation',
	'Maintenance',
] as const

export type Category = (typeof categories)[number]
export const agentNames = ['codex', 'claude'] as const
export const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgentName = (typeof agentNames)[number]
export type Effort = (typeof efforts)[number]

export type Change = {
	breaking: boolean
	category: Category
	description: string
	sources: string[]
}

export type Evidence = {
	/** Git commits associated with pull-request evidence. */
	commits?: string[]
	id: string
	kind: 'commit' | 'manifest' | 'pull-request' | 'range'
	text: string
}

/**
 * One release to describe. This is plain data, so it serves as both prompt
 * input and cache identity.
 */
export type ReleaseRequest = {
	evidence: Evidence[]
	existingEntries: string
	/** Unique and stable across runs; each change set echoes it. */
	id: string
	initialRelease: boolean
	mode: 'initialize' | 'update'
	packageName: string
	/**
	 * Read-only research context in the local checkout; Git snapshots, not the
	 * working tree, define the release.
	 */
	repository: {
		directory: string
		excludeDirectories: string[]
		from?: string
		to: string
	}
	scope: 'package' | 'repository'
	version: string
}

/** How to run a session, as opposed to what it should describe. */
export type RunSettings = {
	effort: Effort
	model?: string
	signal?: AbortSignal
	timeoutMs: number
}

/** One or more releases to research together in a single session. */
export type GenerationRequest = {
	releases: ReleaseRequest[]
	/**
	 * A previous response that failed validation, to correct rather than research
	 * again.
	 */
	repair?: { error: string; response: unknown }
	repositoryRoot: string
	settings: RunSettings
}

export type ChangeSet = {
	changes: Change[]
	id: string
}

export type GenerationResponse = {
	releases: ChangeSet[]
}

export type AgentAdapter = {
	/** Change this identifier when the adapter's generation behavior changes. */
	cacheKey?: string
	/**
	 * Describe every requested release, returning exactly one change set per
	 * release ID.
	 */
	generate: (request: GenerationRequest) => Promise<GenerationResponse>
	name: string
}

export type ReleaseContext = {
	date?: string
	tag?: string
	version: string
}

export type GenerateOptions = Omit<Config, 'agent'> & {
	agent?: AgentAdapter | AgentName
	configFile?: string
	cwd?: string
	/**
	 * Explicitly reconstruct all history instead of preserving existing release
	 * sections.
	 */
	rebuild?: boolean
	release?: ReleaseContext
	signal?: AbortSignal
}

/** Options after configuration layers and defaults have been applied. */
export type ResolvedOptions = Omit<ResolvedConfig, 'agent'> & {
	rebuild: boolean
	release?: ReleaseContext
	signal?: AbortSignal
}

export type PackageInfo = {
	directory: string
	name: string
	version?: string
}

type GitTag = {
	commit: string
	date: string
	name: string
}

export type Repository = {
	gitDirectory: string
	github?: string
	head: string
	packages: PackageInfo[]
	root: string
	rootPackage: PackageInfo
	tags: GitTag[]
}

export type Release = {
	date?: string
	pending?: boolean
	previousRef?: string
	previousTag?: string
	ref: string
	tag?: string
	version: string
}

export type FileEdit = {
	after: string
	before?: string
	path: string
}

type Checkpoint = {
	baseRef: string
	contentHash: string
	head: string
	instructionVersion: string
	path: string
}

export type ReleaseSummary = {
	/** Anchor of the actual package heading, including preserved historical dates. */
	anchor?: string
	changelogPath: string
	changes: Change[]
	date?: string
	packageDirectory: string
	packageName: string
	ref: string
	tag?: string
	version: string
}

export type ChangelogPlan = {
	/** Internal, disposable incremental-generation metadata. */
	checkpoints: Checkpoint[]
	diagnostics: string[]
	files: FileEdit[]
	head: string
	releases: ReleaseSummary[]
	root: string
}
