import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// Repository fixtures spawn many Git processes, which take several seconds on Windows.
		testTimeout: 15_000,
	},
})
