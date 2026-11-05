import { cosmiconfig } from 'cosmiconfig'
import { z } from 'zod'
import { defaults } from './defaults'
import { agentNames, efforts } from './types'

const configSchema = z.strictObject({
	agent: z.enum(agentNames).optional(),
	cache: z.boolean().optional(),
	effort: z.enum(efforts).optional(),
	exclude: z.array(z.string()).optional(),
	github: z.boolean().optional(),
	/** Maximum evidence characters per agent request. */
	maxInputChars: z.number().int().min(4000).optional(),
	model: z.string().min(1).optional(),
	/** Workspace directory globs, overriding manifest workspace discovery. */
	packages: z.array(z.string()).optional(),
	/** Templates containing {version} and optionally {name}. */
	tagPatterns: z.array(z.string().includes('{version}')).optional(),
	timeoutMs: z.number().positive().optional(),
})

const resolvedConfigSchema = configSchema.required({
	agent: true,
	cache: true,
	effort: true,
	github: true,
	maxInputChars: true,
	timeoutMs: true,
})

export type Config = z.infer<typeof configSchema>
export type ResolvedConfig = z.infer<typeof resolvedConfigSchema>

function invalidConfig(source: string, error: z.ZodError): Error {
	return new Error(`Invalid options in ${source}:\n${z.prettifyError(error)}`, { cause: error })
}

/** Define optional repository configuration with TypeScript completion. */
export function defineConfig(config: Config): Config {
	return config
}

/** Load configuration from the repository root or an explicitly selected file. */
export async function loadConfig(root: string, file?: string): Promise<Config> {
	const explorer = cosmiconfig('chagent', {
		searchPlaces: [
			'chagent.config.ts',
			'chagent.config.mjs',
			'chagent.config.js',
			'chagent.config.json',
			'package.json',
		],
		searchStrategy: 'none',
	})
	const result = file === undefined ? await explorer.search(root) : await explorer.load(file)
	if (!result) {
		return {}
	}

	const parsed = configSchema.safeParse(result.config)
	if (!parsed.success) {
		throw invalidConfig(result.filepath, parsed.error)
	}

	return parsed.data
}

/**
 * Apply configuration layers over the defaults; later layers win and undefined
 * values do not.
 */
export function resolveConfig(...layers: Config[]): ResolvedConfig {
	const merged: Record<string, unknown> = { ...defaults }
	for (const layer of layers) {
		for (const [key, value] of Object.entries<unknown>(layer)) {
			if (value !== undefined) {
				merged[key] = value
			}
		}
	}

	const parsed = resolvedConfigSchema.safeParse(merged)
	if (!parsed.success) {
		throw invalidConfig('generation settings', parsed.error)
	}

	return parsed.data
}
