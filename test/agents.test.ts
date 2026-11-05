import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerationRequest } from '../src/lib/types'
import { createAgent } from '../src/lib/agents'
import { runCommand } from '../src/lib/process'
import { createRepository } from './helpers'

afterEach(() => {
	vi.unstubAllEnvs()
})

const request: GenerationRequest = {
	evidence: [{ id: 'abc', kind: 'commit', text: 'Add a new export.' }],
	existingEntries: '',
	packageName: 'example',
	repository: { directory: '.', excludeDirectories: [], root: '', to: 'HEAD' },
	timeoutMs: 5000,
	version: '1.0.0',
}

describe('agent protocols', () => {
	it.each(['codex', 'claude'] as const)(
		'uses %s structured output rather than process chatter',
		async (name) => {
			const root = await createRepository()
			const bin = path.join(root, 'bin')
			await mkdir(bin)
			const file = path.join(bin, process.platform === 'win32' ? name + '.cjs' : name)
			const argsFile = path.join(root, 'arguments.json')
			await writeFile(
				file,
				String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const input = JSON.parse(fs.readFileSync(0, 'utf8').split('Input data (JSON):\n')[1]);
if (process.cwd() !== (input.repositoryRoot ?? input.repository.root)) process.exit(9);
const changes = (release) => [
  { category: 'Added', description: 'Support an additional export.', breaking: false, sources: [release.evidence[0].id] },
  { category: 'Documentation', description: 'Document the new export.', breaking: false, sources: [release.evidence[0].id] },
  { category: 'Maintenance', description: 'Refresh test tooling.', breaking: false, sources: [release.evidence[0].id] },
];
const result = input.releases ? { releases: input.releases.map((release) => ({ id: release.id, changes: changes(release) })) } : { changes: changes(input) };
if (${JSON.stringify(name)} === 'codex') {
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));
  console.log('Unstructured process chatter that must never reach the changelog.');
} else {
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  if (schema.$schema.includes('2020')) process.exit(8);
  console.log(JSON.stringify({ structured_output: result }));
}
`,
			)
			await chmod(file, 0o755)
			if (process.platform === 'win32') {
				await writeFile(path.join(bin, name + '.cmd'), `@node "%~dp0${name}.cjs" %*\r\n`)
			}

			vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`)
			const changes = await createAgent(name).generate({
				...request,
				repository: { directory: '.', excludeDirectories: [], root, to: 'HEAD' },
			})
			expect(changes[0]?.description).toBe('Support an additional export.')
			expect(changes.map((change) => change.category)).toEqual([
				'Added',
				'Documentation',
				'Maintenance',
			])
			const args: unknown = JSON.parse(await readFile(argsFile, 'utf8'))
			expect(args).not.toContain('--bare')
			const expected =
				name === 'codex'
					? [
							'read-only',
							'gpt-6.1-sol',
							'model_reasoning_effort="xhigh"',
							'features.shell_tool=true',
							'approval_policy="never"',
						]
					: [
							'--tools',
							'Read,Glob,Grep,Bash',
							'--safe-mode',
							'--permission-mode',
							'dontAsk',
							'--model',
							'claude-opus-5-5',
							'--effort',
							'xhigh',
						]
			expect(args).toEqual(expect.arrayContaining(expected))
			const history = await createAgent(name).generateHistory!({
				releases: [
					{
						evidence: request.evidence,
						existingEntries: '',
						id: 'first',
						packageName: 'example',
						repository: { directory: '.', excludeDirectories: [], root, to: 'HEAD' },
						version: '1.0.0',
					},
					{
						evidence: [{ id: 'def', kind: 'range', text: 'Inspect the next release.' }],
						existingEntries: '',
						id: 'second',
						packageName: 'example',
						repository: { directory: '.', excludeDirectories: [], root, to: 'HEAD' },
						version: '1.0.1',
					},
				],
				repositoryRoot: root,
				timeoutMs: 5000,
			})
			expect(history.map((release) => release.id)).toEqual(['first', 'second'])
			expect(history.map((release) => release.changes[0]?.sources)).toEqual([['abc'], ['def']])
			expect(JSON.parse(await readFile(argsFile, 'utf8'))).toEqual(expect.arrayContaining(expected))
		},
	)

	it('terminates a subprocess that exceeds its deadline', async () => {
		await expect(
			runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30 }),
		).rejects.toThrow('timed out')
	})

	it('propagates cancellation before starting a subprocess', async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(
			runCommand(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }),
		).rejects.toThrow()
	})
})
