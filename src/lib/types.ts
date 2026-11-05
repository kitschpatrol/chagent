export const categories = [
	'Added',
	'Changed',
	'Deprecated',
	'Removed',
	'Fixed',
	'Security',
] as const

export type Category = (typeof categories)[number]
export type AgentName = 'claude' | 'codex'
export type Effort = 'high' | 'low' | 'max' | 'medium' | 'xhigh'

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
	kind: 'commit' | 'diff' | 'manifest' | 'pull-request' | 'range'
	text: string
}

export type HistoryRelease = Omit<
	GenerationRequest,
	'effort' | 'model' | 'signal' | 'timeoutMs'
> & {
	id: string
}

export type HistoryRequest = Pick<
	GenerationRequest,
	'effort' | 'model' | 'signal' | 'timeoutMs'
> & {
	releases: HistoryRelease[]
	repositoryRoot: string
}

export type HistoryChangeSet = {
	changes: Change[]
	id: string
}

export type GenerationRequest = {
	effort?: Effort
	evidence: Evidence[]
	existingEntries: string
	initialRelease?: boolean
	mode?: 'initialize' | 'update'
	model?: string
	packageName: string
	/**
	 * Read-only research context; Git snapshots, not the working tree, define the
	 * release.
	 */
	repository?: {
		directory: string
		excludeDirectories: string[]
		from?: string
		root: string
		to: string
	}
	scope?: 'package' | 'repository'
	signal?: AbortSignal
	timeoutMs: number
	version: string
}

export type AgentAdapter = {
	/** Change this identifier when the adapter's generation behavior changes. */
	cacheKey?: string
	generate: (request: GenerationRequest) => Promise<Change[]>
	/**
	 * Research several release ranges together, sharing project context in one
	 * session.
	 */
	generateHistory?: (request: HistoryRequest) => Promise<HistoryChangeSet[]>
	name: string
	/**
	 * The adapter can inspect Git history directly instead of requiring supplied
	 * patches.
	 */
	repositoryAccess?: boolean
}

export type Config = {
	agent?: AgentName
	cache?: boolean
	effort?: Effort
	exclude?: string[]
	github?: boolean
	/** Maximum evidence characters per agent request. */
	maxInputChars?: number
	model?: string
	/** Workspace directory globs, overriding manifest workspace discovery. */
	packages?: string[]
	/** Templates containing {version} and optionally {name}. */
	tagPatterns?: string[]
	timeoutMs?: number
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

export type PackageInfo = {
	dependencies: string[]
	directory: string
	name: string
	node?: string
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
