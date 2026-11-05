import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseRequest } from '../src/lib/types'
import { createAgent } from '../src/lib/agents'
import { runCommand } from '../src/lib/process'
import { createRepository } from './helpers'

afterEach(() => {
	vi.unstubAllEnvs()
})

const release: ReleaseRequest = {
	evidence: [{ id: 'abc', kind: 'commit', text: 'Add a new export.' }],
	existingEntries: '',
	id: 'first',
	initialRelease: false,
	mode: 'update',
	packageName: 'example',
	repository: { directory: '.', excludeDirectories: [], to: 'HEAD' },
	scope: 'package',
	version: '1.0.0',
}

/**
 * Put a fake agent CLI on the PATH of a new repository. The source runs after
 * stdin is read, with `fs` and `args` in scope.
 */
async function installAgent(name: 'claude' | 'codex', source: string): Promise<string> {
	const root = await createRepository()
	const bin = path.join(root, 'bin')
	await mkdir(bin)
	const file = path.join(bin, process.platform === 'win32' ? name + '.cjs' : name)
	await writeFile(
		file,
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.readFileSync(0);
${source}
`,
	)
	await chmod(file, 0o755)
	if (process.platform === 'win32') {
		await writeFile(path.join(bin, name + '.cmd'), `@node "%~dp0${name}.cjs" %*\r\n`)
	}

	vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`)
	return root
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
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(path.join(root, 'stdin.txt'))}, stdin);
const input = JSON.parse(stdin.split('Input data (JSON):\n')[1]);
if (process.cwd() !== input.repositoryRoot) process.exit(9);
const changes = (release) => [
  { category: 'Added', description: 'Support an additional export.', breaking: false, sources: [release.evidence[0].id] },
  { category: 'Documentation', description: 'Document the new export.', breaking: false, sources: [release.evidence[0].id] },
  { category: 'Maintenance', description: 'Refresh test tooling.', breaking: false, sources: [release.evidence[0].id] },
];
const result = { releases: input.releases.map((release) => ({ id: release.id, changes: changes(release) })) };
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
			const { releases } = await createAgent(name).generate({
				releases: [
					release,
					{
						...release,
						evidence: [{ id: 'def', kind: 'range', text: 'Inspect the next release.' }],
						id: 'second',
						version: '1.0.1',
					},
				],
				repositoryRoot: root,
				settings: { effort: 'xhigh', timeoutMs: 5000 },
			})
			expect(releases.map(({ id }) => id)).toEqual(['first', 'second'])
			expect(releases[0]?.changes[0]?.description).toBe('Support an additional export.')
			expect(releases[0]?.changes.map((change) => change.category)).toEqual([
				'Added',
				'Documentation',
				'Maintenance',
			])
			expect(releases.map(({ changes }) => changes[0]?.sources)).toEqual([['abc'], ['def']])
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
			expect(await readFile(path.join(root, 'stdin.txt'), 'utf8')).not.toContain(
				'failed validation',
			)
			await createAgent(name).generate({
				releases: [release],
				repair: { error: 'Agent output omitted requested releases.', response: { releases: [] } },
				repositoryRoot: root,
				settings: { effort: 'xhigh', timeoutMs: 5000 },
			})
			const correction = await readFile(path.join(root, 'stdin.txt'), 'utf8')
			expect(correction).toContain('failed validation: Agent output omitted requested releases.')
			expect(correction).toContain('{"releases":[]}')
		},
	)

	it('survives a Codex session whose event stream exceeds the output limit', async () => {
		const root = await installAgent(
			'codex',
			`fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '{"releases":[]}');
fs.writeSync(1, 'event'.repeat(7_000_000));`,
		)
		await expect(
			createAgent('codex').generate({
				releases: [release],
				repositoryRoot: root,
				settings: { effort: 'low', timeoutMs: 30_000 },
			}),
		).resolves.toEqual({ releases: [] })
	}, 40_000)

	it('passes a non-JSON Codex response on for validation to request a correction', async () => {
		const root = await installAgent(
			'codex',
			"fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'Here are the notes.');",
		)
		await expect(
			createAgent('codex').generate({
				releases: [release],
				repositoryRoot: root,
				settings: { effort: 'low', timeoutMs: 5000 },
			}),
		).resolves.toBe('Here are the notes.')
	})

	it.each([
		['codex', '', 'Codex exited without writing a final response.'],
		['claude', "console.log('Not a result.');", 'Claude returned output without a JSON result'],
	] as const)('explains a %s session without a usable result', async (name, source, message) => {
		const root = await installAgent(name, source)
		await expect(
			createAgent(name).generate({
				releases: [release],
				repositoryRoot: root,
				settings: { effort: 'low', timeoutMs: 5000 },
			}),
		).rejects.toThrow(message)
	})

	it('fails a subprocess that exceeds the output limit unless asked to keep only the tail', async () => {
		const script = "process.stdout.write('x'.repeat(33_000_000) + 'end')"
		await expect(runCommand(process.execPath, ['-e', script])).rejects.toThrow(
			'exceeded the output limit',
		)
		const { stdout } = await runCommand(process.execPath, ['-e', script], { tailStdout: true })
		expect(stdout.length).toBeLessThanOrEqual(4000)
		expect(stdout.endsWith('end')).toBe(true)
	})

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

	it('names a command that is not installed', async () => {
		await expect(runCommand('chagent-missing-command', [])).rejects.toThrow(
			'Cannot find chagent-missing-command. Install it and make sure it is on your PATH.',
		)
	})

	it('names a working directory that does not exist', async () => {
		const missing = path.join(os.tmpdir(), `chagent-missing-${crypto.randomUUID()}`)
		await expect(runCommand(process.execPath, ['-e', ''], { cwd: missing })).rejects.toThrow(
			`Cannot run ${process.execPath} in ${missing}: the directory does not exist.`,
		)
	})
})
