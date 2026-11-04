import { cosmiconfig } from 'cosmiconfig'
import { z } from 'zod'
import type { Config } from './types'

const configSchema = z.strictObject({
	agent: z.enum(['codex', 'claude']).optional(),
	cache: z.boolean().optional(),
	effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
	exclude: z.array(z.string()).optional(),
	github: z.boolean().optional(),
	maxInputChars: z.number().int().min(4000).optional(),
	model: z.string().min(1).optional(),
	packages: z.array(z.string()).optional(),
	tagPatterns: z.array(z.string().includes('{version}')).optional(),
	timeoutMs: z.number().int().positive().optional(),
})

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
	return result ? configSchema.parse(result.config) : {}
}
