export const defaults = {
	agent: 'codex',
	cache: true,
	effort: 'xhigh',
	github: true,
	maxInputChars: 80_000,
	rootChangelog: 'summary',
	timeout: 20,
} as const

export const defaultModels = { claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol' }

/** Node.js timers fire immediately when given a longer delay. */
export const maxTimeoutMinutes = 2_147_483_647 / 60_000
