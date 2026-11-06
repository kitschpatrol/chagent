import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { changelogHeader } from '../src/lib/changelog'
import { git, runCommand } from '../src/lib/process'
import { createRepository } from './helpers'

afterEach(() => {
	vi.unstubAllEnvs()
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

const WHITESPACE_RUN = /\s+/gv
const VERSION_REGEX = /\d+\.\d+\.\d+/v
const HELP_DEFAULTS = [
	/--agent[^\n]*\[default: codex\]/v,
	/--effort[^\n]*\[default: xhigh\]/v,
	/--github[^\n]*\[default: true\]/v,
	/--cache[^\n]*\[default: true\]/v,
	/--timeout[^\n]*\[default: 20\]/v,
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
fs.appendFileSync(${JSON.stringify(path.join(root, '.git', 'calls.jsonl'))}, JSON.stringify({name, args, pid: process.pid}) + '\n');
const stdin = fs.readFileSync(0, 'utf8');
if (name === 'gh') {
  if (args.includes('graphql')) console.log(JSON.stringify({data: {repository: {}}}));
} else {
  const input = JSON.parse(stdin.split('Input data (JSON):\n')[1]);
  const result = {releases: input.releases.map((release) => ({id: release.id, changes: [{category: 'Added', description: 'Provide the answer export.', breaking: false, sources: [release.evidence[0].id]}]}))};
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

async function cliCalls(
	root: string,
): Promise<Array<{ args: string[]; name: string; pid: number }>> {
	const calls = await readFile(path.join(root, '.git', 'calls.jsonl'), 'utf8')
	return z.array(z.object({ args: z.array(z.string()), name: z.string(), pid: z.number() })).parse(
		calls
			.trim()
			.split('\n')
			.map((line): unknown => JSON.parse(line)),
	)
}

async function runningAgent(root: string): Promise<{ pid: number }> {
	return vi.waitFor(
		async () => {
			const calls = await cliCalls(root)
			const call = calls.find(({ name }) => name === 'codex')
			expect(call).toBeDefined()
			return call!
		},
		{ interval: 50, timeout: 10_000 },
	)
}

// Vitest has no pty, so report a terminal on piped stderr to reach the progress line.
const FAKE_TERMINAL = `data:text/javascript,${encodeURIComponent(
	'process.stderr.isTTY = true; process.stderr.columns = 80;',
)}`

function startInFakeTerminal(root: string, ...args: string[]) {
	const child = spawn(process.execPath, [`--import=${FAKE_TERMINAL}`, cliPath, ...args], {
		cwd: root,
	})
	const output = { stderr: '', stdout: '' }
	child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
		output.stderr += chunk
	})
	child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
		output.stdout += chunk
	})
	const exit = new Promise<number | undefined>((resolve, reject) => {
		child.once('error', reject)
		child.once('close', (code) => {
			resolve(code ?? undefined)
		})
	})
	return { child, exit, output }
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
	})

	it('reports diagnostics during a dry run', async () => {
		const root = await createRepository({ 'chagent.config.json': '{"cache":false}' })
		await git(root, ['tag', 'v1.0.0'])
		await git(root, ['remote', 'add', 'origin', 'https://github.com/example/fixture.git'])
		await installCliFixtures(root)
		await writeFile(
			path.join(root, '.git', 'test-bin', process.platform === 'win32' ? 'gh.cjs' : 'gh'),
			'#!/usr/bin/env node\nconsole.error("Not authenticated.");\nprocess.exit(1);\n',
		)
		const result = await runCommand(process.execPath, [cliPath, '--dry-run'], { cwd: root })
		expect(result.stdout).toContain('Provide the answer export.')
		expect(result.stderr).toContain('GitHub enrichment unavailable')
	})

	it('logs extra detail to stderr only with --verbose', async () => {
		const root = await createRepository({ 'chagent.config.json': '{"github":false}' })
		await installCliFixtures(root)
		const first = await runCommand(process.execPath, [cliPath, '--dry-run', '--no-cache'], {
			cwd: root,
		})
		expect(first.stderr).not.toContain('Running:')
		expect(first.stderr).not.toContain('Resolved options')
		expect(first.stderr).toBe('Researching example Unreleased.\n')
		const verbose = await runCommand(process.execPath, [cliPath, '--dry-run', '--verbose'], {
			cwd: root,
		})
		expect(verbose.stdout).toContain('Provide the answer export.')
		expect(verbose.stdout).not.toContain('Running:')
		expect(verbose.stderr).not.toContain('\u{1B}[')
		expect(verbose.stderr).not.toContain('[example]')
		// The logger wraps long lines.
		const details = verbose.stderr.replaceAll(WHITESPACE_RUN, ' ')
		for (const detail of [
			'Loaded configuration from',
			'Resolved options:',
			'workspace packages',
			'Running: git',
			'Running: codex',
			'Finished codex (exit 0)',
			'evidence items',
			'Starting a codex session for .@Unreleased with model default, effort xhigh',
			'The codex session finished in',
		]) {
			expect(details).toContain(detail)
		}

		const cached = await runCommand(process.execPath, [cliPath, '--dry-run', '--verbose'], {
			cwd: root,
		})
		expect(cached.stderr.replaceAll(WHITESPACE_RUN, ' ')).toContain(
			'Using the cached draft for .@Unreleased.',
		)
		expect(cached.stderr).not.toContain('Running: codex')
	})

	it('uses the configured timeout unless --timeout explicitly overrides it', async () => {
		const root = await createRepository({
			'chagent.config.json': '{"cache":false,"github":false,"timeout":0.001}',
		})
		await installCliFixtures(root, 250)
		const configured = await runCommand(process.execPath, [cliPath, '--dry-run'], {
			allowFailure: true,
			cwd: root,
		})
		expect(configured.code).toBe(1)
		expect(configured.stderr).toContain('codex timed out')
		const overridden = await runCommand(process.execPath, [cliPath, '--dry-run', '--timeout=20'], {
			cwd: root,
		})
		expect(overridden.stdout).toContain('Provide the answer export.')
	})

	it('rejects invalid flags and timeout values', async () => {
		const unknown = await run('--unknown-option')
		const timeout = await run('--timeout', '-1')
		const overflow = await run('--timeout', '40000')
		expect(unknown.code).toBe(1)
		expect(unknown.stderr).toContain('Options:')
		expect(unknown.stderr).toContain('Unknown arguments: unknown-option')
		expect(timeout.code).toBe(1)
		expect(timeout.stderr).toContain('positive number')
		expect(overflow.code).toBe(1)
		expect(overflow.stderr).toContain('up to 35791')
	})

	it.each([
		[['--interactive'], 'Interactive review requires a terminal'],
		[['--amend'], 'recognizable release commit message'],
	])('refuses %s before starting an agent session', async (flags, message) => {
		const root = await createRepository()
		await git(root, ['tag', 'v1.0.0'])
		await writeFile(path.join(root, 'index.js'), 'export const answer = 43\n')
		await git(root, ['commit', '-am', 'Change the answer.'])
		await installCliFixtures(root)
		const result = await runCommand(process.execPath, [cliPath, '--no-github', ...flags], {
			allowFailure: true,
			cwd: root,
		})
		expect(result.code).toBe(1)
		expect(result.stderr).toContain(message)
		await expect(readFile(path.join(root, '.git', 'calls.jsonl'))).rejects.toThrow()
	})

	it('reports a failure while running as its message alone', async () => {
		const root = await createRepository()
		await rm(path.join(root, '.git'), { force: true, recursive: true })
		const { code, stderr, stdout } = await run('--cwd', root, '--no-github')
		expect(code).toBe(1)
		expect(stdout).toBe('')
		expect(stderr.trim().split('\n')).toEqual([expect.stringContaining('not a git repository')])
	})

	it('runs without flags and writes a canonical changelog without committing', async () => {
		const root = await createRepository()
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
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ releases: input.releases.map((release) => ({ id: release.id, changes: [{ category: 'Added', description: 'Provide the answer export.', breaking: false, sources: [release.evidence[0].id] }] })) }));
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

	it('keeps generating when keys arrive on stdin', async () => {
		const root = await createRepository()
		await installCliFixtures(root, 500)
		const { child, exit, output } = startInFakeTerminal(
			root,
			'--dry-run',
			'--no-cache',
			'--no-github',
		)
		child.stdin.write('\u{3}')
		expect(await exit).toBe(0)
		expect(output.stdout).toContain('Provide the answer export.')
	})

	// Windows has no catchable signal to send a child process.
	it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGHUP'] as const)(
		'cancels running agents and restores the cursor on %s',
		async (signal) => {
			const root = await createRepository()
			await installCliFixtures(root, 60_000)
			const { child, exit, output } = startInFakeTerminal(root, '--no-cache', '--no-github')
			const agent = await runningAgent(root)
			child.kill(signal)
			expect(await exit).toBe(1)
			expect(() => process.kill(agent.pid, 0)).toThrow()
			const cursorRestored = output.stderr.indexOf('\u{1B}[?25h')
			expect(cursorRestored).toBeGreaterThan(-1)
			expect(output.stderr.indexOf('codex was cancelled.')).toBeGreaterThan(cursorRestored)
			await expect(readFile(path.join(root, 'changelog.md'))).rejects.toThrow()
		},
	)

	it.skipIf(process.platform === 'win32')(
		'restores the cursor on the first interrupt when a stuck run needs a second to exit',
		async () => {
			const root = await createRepository()
			await installCliFixtures(root)
			// A grandchild in its own process group outlives cancellation and holds the agent's pipes open.
			await writeFile(
				path.join(root, '.git', 'test-bin', 'codex'),
				String.raw`#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
spawn('sleep', ['5'], { detached: true, stdio: 'inherit' }).unref();
fs.appendFileSync(${JSON.stringify(path.join(root, '.git', 'calls.jsonl'))}, JSON.stringify({name: 'codex', args: [], pid: process.pid}) + '\n');
setTimeout(() => {}, 60000);
`,
			)
			const { child, exit, output } = startInFakeTerminal(root, '--no-cache', '--no-github')
			await vi.waitFor(async () => cliCalls(root), { interval: 50, timeout: 10_000 })
			child.kill('SIGINT')
			await vi.waitFor(
				() => {
					expect(output.stderr).toContain('\u{1B}[?25h')
				},
				{ interval: 50, timeout: 3000 },
			)
			expect(child.exitCode).toBeNull()
			child.kill('SIGINT')
			expect(await exit).toBeUndefined()
			expect(child.signalCode).toBe('SIGINT')
		},
	)

	it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGHUP', 'SIGTERM'] as const)(
		'stops running agents when a library host without handlers receives %s',
		async (signal) => {
			const root = await createRepository()
			await installCliFixtures(root, 60_000)
			const library = pathToFileURL(path.resolve(import.meta.dirname, '../dist/lib/index.js')).href
			const host = spawn(
				process.execPath,
				[
					'--input-type=module',
					'--eval',
					`import { generateChangelog } from ${JSON.stringify(library)}\nawait generateChangelog({ cache: false, github: false })`,
				],
				{ cwd: root },
			)
			const exit = new Promise<void>((resolve) => {
				host.once('close', () => {
					resolve()
				})
			})
			const agent = await runningAgent(root)
			host.kill(signal)
			await exit
			expect(host.signalCode).toBe(signal)
			await vi.waitFor(
				() => {
					expect(() => process.kill(agent.pid, 0)).toThrow()
				},
				{ interval: 50, timeout: 3000 },
			)
		},
	)
})
