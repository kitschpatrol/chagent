import crossSpawn from 'cross-spawn'
import { existsSync } from 'node:fs'
import { log } from './log'

const STDOUT_LIMIT = 32_000_000
const STDERR_LIMIT = 4_000_000
const FAILURE_OUTPUT_LENGTH = 4000
const LOGGED_COMMAND_LENGTH = 300
const OBJECT_BATCH_SIZE = 500
const OBJECT_HEADER = /^[\da-f]+ (\w+) (\d+)$/v
const TERMINATING_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const

/** Process groups of running detached commands. */
const groups = new Set<number>()
const signalListeners = new Map<NodeJS.Signals, () => void>()

function killGroup(pid: number): void {
	try {
		process.kill(-pid, 'SIGKILL')
	} catch {
		// The group may have exited already.
	}
}

function removeSignalListeners(): void {
	for (const [signal, listener] of signalListeners) {
		process.off(signal, listener)
	}

	signalListeners.clear()
}

/**
 * Detached commands never receive the terminal's signals, so a signal that
 * would end this process by default must stop them first. Hosts with their own
 * handler, like the CLI, keep responsibility for cancelling.
 */
function trackGroup(pid: number): void {
	if (groups.size === 0) {
		for (const signal of TERMINATING_SIGNALS) {
			if (process.listenerCount(signal) > 0) {
				continue
			}

			const listener = () => {
				for (const group of groups) {
					killGroup(group)
				}

				groups.clear()
				removeSignalListeners()
				// Restore the default action, which ends the process with this signal.
				if (process.listenerCount(signal) === 0) {
					process.kill(process.pid, signal)
				}
			}

			signalListeners.set(signal, listener)
			process.on(signal, listener)
		}
	}

	groups.add(pid)
}

function untrackGroup(pid: number): void {
	groups.delete(pid)
	if (groups.size === 0) {
		removeSignalListeners()
	}
}

type CommandOptions = {
	allowFailure?: boolean
	cwd?: string
	encoding?: BufferEncoding
	env?: NodeJS.ProcessEnv
	inherit?: boolean
	input?: string
	signal?: AbortSignal
	/** Keep only the end of stdout, for long event streams that nothing parses. */
	tailStdout?: boolean
	timeoutMs?: number
}

/**
 * Explain a failed spawn; Node reports a missing command and a missing working
 * directory with the same ENOENT code.
 */
function spawnFailure(command: string, cwd: string | undefined, error: Error): string {
	if (!('code' in error) || error.code !== 'ENOENT') {
		return `Could not run ${command}: ${error.message}`
	}

	return cwd === undefined || existsSync(cwd)
		? `Cannot find ${command}. Install it and make sure it is on your PATH.`
		: `Cannot run ${command} in ${cwd}: the directory does not exist.`
}

/** Run a command with argument boundaries preserved and bounded output. */
export async function runCommand(
	command: string,
	args: string[],
	options: CommandOptions = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
	options.signal?.throwIfAborted()
	log.debug(`Running: ${[command, ...args].join(' ').slice(0, LOGGED_COMMAND_LENGTH)}`)
	const started = performance.now()
	return new Promise((resolve, reject) => {
		const detached = options.inherit !== true && process.platform !== 'win32'
		const child = crossSpawn(command, args, {
			cwd: options.cwd,
			detached,
			env: options.env ?? process.env,
			stdio: options.inherit === true ? 'inherit' : 'pipe',
			windowsHide: true,
		})
		const group = detached ? child.pid : undefined
		if (group !== undefined) {
			trackGroup(group)
		}

		let stdout = ''
		let stderr = ''
		let failure: Error | undefined
		const stop = (message: string) => {
			failure = new Error(message)
			if (group === undefined) {
				child.kill('SIGKILL')
			} else {
				killGroup(group)
			}
		}

		const abort = () => {
			stop(`${command} was cancelled.`)
		}

		const timer = setTimeout(stop, options.timeoutMs ?? 60_000, `${command} timed out.`)
		timer.unref()
		options.signal?.addEventListener('abort', abort, { once: true })
		child.stdout?.setEncoding(options.encoding ?? 'utf8').on('data', (chunk: string) => {
			stdout += chunk
			if (options.tailStdout === true) {
				stdout = stdout.slice(-FAILURE_OUTPUT_LENGTH)
			} else if (stdout.length > STDOUT_LIMIT) {
				stop(`${command} exceeded the output limit.`)
			}
		})
		child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
			stderr += chunk
			if (stderr.length > STDERR_LIMIT) {
				stop(`${command} exceeded the error output limit.`)
			}
		})
		child.stdin?.on('error', () => {
			// Early subprocess exits are reported by the close handler.
		})
		child.stdin?.end(options.input)
		child.on('error', (error) => {
			failure = new Error(spawnFailure(command, options.cwd, error), { cause: error })
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			options.signal?.removeEventListener('abort', abort)
			if (group !== undefined) {
				untrackGroup(group)
			}

			const exitCode = code ?? 1
			log.debug(
				`Finished ${command} (exit ${exitCode}) in ${Math.round(performance.now() - started)} ms.`,
			)
			if (failure) {
				reject(failure)
			} else if (exitCode === 0 || options.allowFailure === true) {
				resolve({ code: exitCode, stderr, stdout })
			} else {
				reject(
					new Error(
						`${command} failed (${exitCode}): ${(stderr === '' ? stdout : stderr).trim().slice(-FAILURE_OUTPUT_LENGTH)}`,
					),
				)
			}
		})
	})
}

async function runGit(
	root: string,
	args: string[],
	options: Pick<CommandOptions, 'allowFailure' | 'encoding' | 'input'> = {},
): ReturnType<typeof runCommand> {
	// eslint-disable-next-line ts/naming-convention -- Git defines these environment variable names.
	const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
	return runCommand('git', ['--no-pager', '-c', 'core.quotepath=false', ...args], {
		...options,
		cwd: root,
		env,
	})
}

/** Run Git without a shell, pager, or external diff driver. */
export async function git(root: string, args: string[], allowFailure = false): Promise<string> {
	const result = await runGit(root, args, { allowFailure })
	return result.code === 0 ? result.stdout.trimEnd() : ''
}

/** Check whether one commit is reachable from another. */
export async function isAncestor(
	root: string,
	ancestor: string,
	descendant: string,
): Promise<boolean> {
	const result = await runGit(root, ['merge-base', '--is-ancestor', ancestor, descendant], {
		allowFailure: true,
	})
	return result.code === 0
}

/**
 * Read many files from Git, named like `commit:path/to/file`, without a process
 * for each one.
 *
 * @returns Text by object name. Anything absent or not a file is left out.
 */
export async function readBlobs(root: string, objects: string[]): Promise<Map<string, string>> {
	const blobs = new Map<string, string>()
	// Names are newline-delimited, so a path containing a newline cannot be requested.
	const names = [...new Set(objects)].filter((name) => !name.includes('\n'))
	for (let start = 0; start < names.length; start += OBJECT_BATCH_SIZE) {
		const batch = names.slice(start, start + OBJECT_BATCH_SIZE)
		// Object sizes count bytes, which line up with characters only in latin1.
		const { stdout } = await runGit(root, ['cat-file', '--batch'], {
			encoding: 'latin1',
			input: batch.join('\n') + '\n',
		})
		let offset = 0
		for (const name of batch) {
			const headerEnd = stdout.indexOf('\n', offset)
			const header = OBJECT_HEADER.exec(stdout.slice(offset, headerEnd))
			offset = headerEnd + 1
			if (header === null) {
				continue
			}

			const size = Number(header[2])
			if (header[1] === 'blob') {
				blobs.set(name, Buffer.from(stdout.slice(offset, offset + size), 'latin1').toString('utf8'))
			}

			offset += size + 1
		}
	}

	return blobs
}
