import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
