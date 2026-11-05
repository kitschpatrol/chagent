import type { Writable } from 'node:stream'
import { unicode } from '@clack/prompts'
import { styleText } from 'node:util'

const FRAMES = unicode ? ['◒', '◐', '◓', '◑'] : ['•', 'o', 'O', '0']
const FRAME_INTERVAL_MS = 80
const FRAME_PADDING = '  '
const CLEAR_TO_LINE_END = '\u{1B}[K'
const HIDE_CURSOR = '\u{1B}[?25l'
const SHOW_CURSOR = '\u{1B}[?25h'
const TRAILING_PERIOD = /\.$/v

function formatElapsed(milliseconds: number): string {
	const seconds = Math.floor(milliseconds / 1000)
	const minutes = Math.floor(seconds / 60)
	return minutes > 0 ? `[${minutes}m ${seconds % 60}s]` : `[${seconds}s]`
}

/**
 * Create a status line with an elapsed timer. Each redraw is one write that
 * overwrites the line in place, so the terminal never shows it blank.
 */
export function createProgressLine(stream: Writable & { columns?: number }) {
	let message = ''
	let started = 0
	let tick = 0
	let timer: NodeJS.Timeout | undefined

	const line = () => {
		const frame = FRAMES[tick % FRAMES.length] ?? ''
		tick += 1
		const elapsed = formatElapsed(performance.now() - started)
		const { columns = 0 } = stream
		// Stop short of the last column, where a terminal holds the cursor before wrapping.
		const width =
			columns > 0 ? Math.max(0, columns - 1 - frame.length - FRAME_PADDING.length) : Infinity
		const status = message.slice(0, Math.max(0, width - elapsed.length - 1))
		const text = `${status} ${elapsed}`.slice(0, width)
		return `\r${styleText('magenta', frame, { stream })}${FRAME_PADDING}${text}${CLEAR_TO_LINE_END}`
	}

	const update = (text: string) => {
		message = text.replace(TRAILING_PERIOD, '')
	}

	const stop = () => {
		if (timer === undefined) {
			return
		}

		clearInterval(timer)
		timer = undefined
		process.off('exit', stop)
		stream.write(`\r${CLEAR_TO_LINE_END}${SHOW_CURSOR}`)
	}

	return {
		/** Blank the line so other output can print; the next redraw restores it. */
		clear() {
			if (timer !== undefined) {
				stream.write(`\r${CLEAR_TO_LINE_END}`)
			}
		},
		start(text: string) {
			update(text)
			started = performance.now()
			process.once('exit', stop)
			stream.write(`${HIDE_CURSOR}${line()}`)
			timer = setInterval(() => {
				stream.write(line())
			}, FRAME_INTERVAL_MS)
		},
		stop,
		update,
	}
}
