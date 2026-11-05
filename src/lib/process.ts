import crossSpawn from 'cross-spawn'

type CommandOptions = {
	allowFailure?: boolean
	cwd?: string
	env?: NodeJS.ProcessEnv
	inherit?: boolean
	input?: string
	signal?: AbortSignal
	timeoutMs?: number
}

/** Run a command with argument boundaries preserved and bounded output. */
export async function runCommand(
	command: string,
	args: string[],
	options: CommandOptions = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
	options.signal?.throwIfAborted()
	return new Promise((resolve, reject) => {
		const detached = options.inherit !== true && process.platform !== 'win32'
		const child = crossSpawn(command, args, {
			cwd: options.cwd,
			detached,
			env: options.env ?? process.env,
			stdio: options.inherit === true ? 'inherit' : 'pipe',
			windowsHide: true,
		})
		let stdout = ''
		let stderr = ''
		let failure: Error | undefined
		const stop = (message: string) => {
			failure = new Error(message)
			try {
				if (!detached || child.pid === undefined) {
					child.kill('SIGKILL')
				} else {
					process.kill(-child.pid, 'SIGKILL')
				}
			} catch {
				// The process may have exited just before cancellation.
			}
		}

		const abort = () => {
			stop(`${command} was cancelled.`)
		}

		const timer = setTimeout(stop, options.timeoutMs ?? 60_000, `${command} timed out.`)
		timer.unref()
		options.signal?.addEventListener('abort', abort, { once: true })
		child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
			stdout += chunk
			if (stdout.length > 32_000_000) {
				stop(`${command} exceeded the output limit.`)
			}
		})
		child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
			stderr += chunk
			if (stderr.length > 4_000_000) {
				stop(`${command} exceeded the error output limit.`)
			}
		})
		child.stdin?.on('error', () => {
			// Early subprocess exits are reported by the close handler.
		})
		child.stdin?.end(options.input)
		child.on('error', (error) => {
			failure = new Error(`Could not run ${command}: ${error.message}`, { cause: error })
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			options.signal?.removeEventListener('abort', abort)
			const exitCode = code ?? 1
			if (failure) {
				reject(failure)
			} else if (exitCode === 0 || options.allowFailure === true) {
				resolve({ code: exitCode, stderr, stdout })
			} else {
				reject(
					new Error(
						`${command} failed (${exitCode}): ${(stderr === '' ? stdout : stderr).trim().slice(-4000)}`,
					),
				)
			}
		})
	})
}

/** Run Git without a shell, pager, or external diff driver. */
export async function git(root: string, args: string[], allowFailure = false): Promise<string> {
	// eslint-disable-next-line ts/naming-convention -- Git defines these environment variable names.
	const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
	const result = await runCommand('git', ['--no-pager', '-c', 'core.quotepath=false', ...args], {
		allowFailure,
		cwd: root,
		env,
	})
	return result.code === 0 ? result.stdout.trimEnd() : ''
}

/** Check whether one commit is reachable from another. */
export async function isAncestor(
	root: string,
	ancestor: string,
	descendant: string,
): Promise<boolean> {
	const result = await runCommand('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
		allowFailure: true,
		cwd: root,
	})
	return result.code === 0
}
