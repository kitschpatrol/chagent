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
	id: string
	kind: 'commit' | 'diff' | 'manifest' | 'pull-request'
	text: string
}

export type GenerationRequest = {
	effort?: Effort
	evidence: Evidence[]
	existingEntries: string
	model?: string
	packageName: string
	scope?: 'package' | 'repository'
	signal?: AbortSignal
	timeoutMs: number
	version: string
}

export type AgentAdapter = {
	/** Change this identifier when the adapter's generation behavior changes. */
	cacheKey?: string
	generate: (request: GenerationRequest) => Promise<Change[]>
	name: string
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
