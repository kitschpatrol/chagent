import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerationRequest } from '../src/lib/types'
import { createAgent } from '../src/lib/agents'
import { runCommand } from '../src/lib/process'
import { createRepository } from './helpers'

const directories: string[] = []
afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(
		directories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })),
	)
})

const request: GenerationRequest = {
	evidence: [{ id: 'abc', kind: 'diff', text: 'Add a new export.' }],
	existingEntries: '',
	packageName: 'example',
	timeoutMs: 5000,
	version: '1.0.0',
}

describe('agent protocols', () => {
	it.each(['codex', 'claude'] as const)(
		'uses %s structured output rather than process chatter',
		async (name) => {
			const root = await createRepository()
			directories.push(root)
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
const result = { changes: [{ category: 'Added', description: 'Support an additional export.', breaking: false, sources: [input.evidence[0].id] }] };
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
			const changes = await createAgent(name).generate(request)
			expect(changes[0]?.description).toBe('Support an additional export.')
			const args: unknown = JSON.parse(await readFile(argsFile, 'utf8'))
			expect(args).not.toContain('--bare')
			const expected =
				name === 'codex'
					? ['read-only', 'gpt-6.1-sol', 'model_reasoning_effort="xhigh"']
					: ['--tools', '']
			expect(args).toEqual(expect.arrayContaining(expected))
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
