import { execFile } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

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
})
