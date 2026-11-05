import { defineConfig } from 'tsdown'

export default defineConfig({
	attw: { profile: 'esm-only' },
	dts: { entry: ['src/lib/bumpp.ts', 'src/lib/index.ts'] },
	entry: {
		'bin/cli': 'src/bin/cli.ts',
		'lib/bumpp': 'src/lib/bumpp.ts',
		'lib/index': 'src/lib/index.ts',
	},
	fixedExtension: false,
	minify: false,
	outDir: 'dist',
	platform: 'node',
	publint: true,
	tsconfig: 'tsconfig.build.json',
})
