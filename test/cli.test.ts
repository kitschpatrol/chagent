import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { changelogHeader } from '../src/lib/changelog'
import { git, runCommand } from '../src/lib/process'
import { createRepository } from './helpers'

const directories: string[] = []
afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(
		directories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })),
	)
})

const cliPath = path.resolve(import.meta.dirname, '../dist/bin/cli.js')

async function run(...args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
	return new Promise((resolve, reject) => {
		execFile('node', [cliPath, ...args], (error, stdout, stderr) => {
			if (error && error.code === undefined) {
				reject(new Error(error.message))
				return
			}

			resolve({ code: typeof error?.code === 'number' ? error.code : 0, stderr, stdout })
		})
	})
}

const VERSION_REGEX = /\d+\.\d+\.\d+/v
const HELP_DEFAULTS = [
	/--agent[^\n]*\[default: "codex"\]/v,
	/--effort[^\n]*\[default: "xhigh"\]/v,
	/--github[^\n]*\[default: true\]/v,
	/--cache[^\n]*\[default: true\]/v,
	/--timeout[^\n]*\[default: 1200\]/v,
]

async function installCliFixtures(root: string, delay = 0): Promise<void> {
	const bin = path.join(root, '.git', 'test-bin')
	await mkdir(bin, { recursive: true })
	for (const name of ['codex', 'claude', 'gh']) {
		const executable = path.join(bin, process.platform === 'win32' ? name + '.cjs' : name)
		await writeFile(
			executable,
			String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const name = ${JSON.stringify(name)};
fs.appendFileSync(${JSON.stringify(path.join(root, '.git', 'calls.jsonl'))}, JSON.stringify({name, args}) + '\n');
const stdin = fs.readFileSync(0, 'utf8');
if (name === 'gh') {
  if (args.includes('graphql')) console.log(JSON.stringify({data: {repository: {}}}));
} else {
  const input = JSON.parse(stdin.split('Input data (JSON):\n')[1]);
  const result = {changes: [{category: 'Added', description: 'Provide the answer export.', breaking: false, sources: [input.evidence[0].id]}]};
  setTimeout(() => {
    if (name === 'codex') fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));
    else console.log(JSON.stringify({structured_output: result}));
  }, ${delay});
}
`,
		)
		await chmod(executable, 0o755)
		if (process.platform === 'win32') {
			await writeFile(path.join(bin, name + '.cmd'), `@node "%~dp0${name}.cjs" %*\r\n`)
		}
	}

	vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`)
}

async function cliCalls(root: string): Promise<Array<{ args: string[]; name: string }>> {
	const calls = await readFile(path.join(root, '.git', 'calls.jsonl'), 'utf8')
	return z.array(z.object({ args: z.array(z.string()), name: z.string() })).parse(
		calls
			.trim()
			.split('\n')
			.map((line): unknown => JSON.parse(line)),
	)
}

describe('cli', () => {
	it('should print version with --version', async () => {
		const { code, stdout } = await run('--version')
		expect(code).toBe(0)
		expect(stdout.trim()).toMatch(VERSION_REGEX)
	})

	it('should print help with --help', async () => {
		const { code, stdout } = await run('--help')
		expect(code).toBe(0)
		expect(stdout).toContain('--help')
		for (const pattern of HELP_DEFAULTS) {
			expect(stdout).toMatch(pattern)
		}

		expect(stdout).not.toContain('(default: 1200)')
	})

	it('preserves repository options and accepts explicit flags equal to built-in defaults', async () => {
		const root = await createRepository({
			'chagent.config.json': JSON.stringify({
				agent: 'claude',
				cache: false,
				effort: 'low',
				github: false,
				model: 'configured-model',
			}),
		})
		directories.push(root)
		await git(root, ['tag', 'v1.0.0'])
		await git(root, ['remote', 'add', 'origin', 'https://github.com/example/fixture.git'])
		await installCliFixtures(root)
		await runCommand(process.execPath, [cliPath, '--dry-run'], { cwd: root })
		await runCommand(process.execPath, [cliPath, '--dry-run'], { cwd: root })
		const configured = await cliCalls(root)
		expect(configured.map((call) => call.name)).toEqual(['claude', 'claude'])
		expect(configured[0]?.args).toEqual(
			expect.arrayContaining(['--model', 'configured-model', '--effort', 'low']),
		)
		const args = [
			cliPath,
			'--dry-run',
			'--agent=codex',
			'--effort=xhigh',
			'--model=override-model',
			'--cache',
			'--github',
		]
		await runCommand(process.execPath, args, { cwd: root })
		await runCommand(process.execPath, args, { cwd: root })
		const overridden = await cliCalls(root)
		const codex = overridden.filter((call) => call.name === 'codex')
		expect(codex).toHaveLength(1)
		expect(codex[0]?.args).toEqual(
			expect.arrayContaining(['--model', 'override-model', 'model_reasoning_effort="xhigh"']),
		)
		expect(overridden.some((call) => call.name === 'gh')).toBe(true)
		await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
	}, 15_000)

	it('uses the configured timeout unless --timeout explicitly overrides it', async () => {
		const root = await createRepository({
			'chagent.config.json': '{"cache":false,"github":false,"timeoutMs":50}',
		})
		directories.push(root)
		await installCliFixtures(root, 250)
		const configured = await runCommand(process.execPath, [cliPath, '--dry-run'], {
			allowFailure: true,
			cwd: root,
		})
		expect(configured.code).toBe(1)
		expect(configured.stderr).toContain('codex timed out')
		const overridden = await runCommand(
			process.execPath,
			[cliPath, '--dry-run', '--timeout=1200'],
			{ cwd: root },
		)
		expect(overridden.stdout).toContain('Provide the answer export.')
	})

	it('rejects invalid flags and timeout values', async () => {
		const unknown = await run('--unknown-option')
		const timeout = await run('--timeout', '-1')
		expect(unknown.code).toBe(1)
		expect(timeout.code).toBe(1)
		expect(timeout.stderr).toContain('positive number')
	})

	it('runs without flags and writes a canonical changelog without committing', async () => {
		const root = await createRepository()
		directories.push(root)
		const head = await git(root, ['rev-parse', 'HEAD'])
		const bin = path.join(root, '.git', 'test-bin')
		await mkdir(bin)
		const executable = path.join(bin, process.platform === 'win32' ? 'codex.cjs' : 'codex')
		await writeFile(
			executable,
			String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(0, 'utf8').split('Input data (JSON):\n')[1]);
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ changes: [{ category: 'Added', description: 'Provide the answer export.', breaking: false, sources: [input.evidence[0].id] }] }));
console.log('Process chatter excluded from the output.');
`,
		)
		await chmod(executable, 0o755)
		if (process.platform === 'win32') {
			await writeFile(path.join(bin, 'codex.cmd'), '@node "%~dp0codex.cjs" %*\r\n')
		}

		vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`)
		await runCommand(process.execPath, [cliPath], { cwd: root })
		const file = await readFile(path.join(root, 'changelog.md'), 'utf8')
		expect(file.startsWith(changelogHeader)).toBe(true)
		expect(file).toContain('Provide the answer export.')
		expect(file).not.toContain('Process chatter')
		expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head)
		expect(await git(root, ['diff', '--cached', '--name-only'])).toBe('')
		await runCommand(process.execPath, [cliPath], { cwd: root })
		expect(await readFile(path.join(root, 'changelog.md'), 'utf8')).toBe(file)
	})
})
