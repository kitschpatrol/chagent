import { Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgressLine } from '../src/lib/progress'

const CLEAR_TO_LINE_END = '\u{1B}[K'
const HIDE_CURSOR = '\u{1B}[?25l'
const SHOW_CURSOR = '\u{1B}[?25h'
const FRAME_INTERVAL_MS = 80
const LONG_MESSAGE = `Researching ${'x'.repeat(200)}`

function createTerminal(columns = 200) {
	const writes: string[] = []
	const stream = Object.assign(
		new Writable({
			write(chunk: string | Uint8Array, _encoding, callback) {
				writes.push(String(chunk))
				callback()
			},
		}),
		{ columns },
	)
	return {
		lastLine: () => stripVTControlCharacters(writes.at(-1) ?? '').replace('\r', ''),
		stream,
		writes,
	}
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('createProgressLine', () => {
	it('redraws in single writes that never leave the line blank', () => {
		const { stream, writes } = createTerminal()
		const progress = createProgressLine(stream)
		progress.start('Researching')
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 5)
		progress.stop()

		const redraws = writes.slice(0, -1)
		expect(redraws).toHaveLength(6)
		for (const redraw of redraws) {
			expect(redraw).toContain('\r')
			expect(redraw).toContain('Researching [0s]')
			expect(redraw.endsWith(CLEAR_TO_LINE_END)).toBe(true)
		}

		expect(redraws[0]?.startsWith(HIDE_CURSOR)).toBe(true)
	})

	it('shows updated messages without their trailing period', () => {
		const { lastLine, stream } = createTerminal()
		const progress = createProgressLine(stream)
		progress.start('Reading repository history.')
		expect(lastLine()).toContain('Reading repository history [0s]')
		progress.update('Researching chagent 1.0.0.')
		vi.advanceTimersByTime(FRAME_INTERVAL_MS)
		expect(lastLine()).toContain('Researching chagent 1.0.0 [0s]')
		progress.stop()
	})

	it('formats elapsed time in seconds and then minutes', () => {
		const { lastLine, stream } = createTerminal()
		const progress = createProgressLine(stream)
		progress.start('Researching')
		vi.advanceTimersByTime(59_999)
		expect(lastLine()).toContain('[59s]')
		vi.advanceTimersByTime(FRAME_INTERVAL_MS)
		expect(lastLine()).toContain('[1m 0s]')
		vi.advanceTimersByTime(225_000)
		expect(lastLine()).toContain('[4m 45s]')
		progress.stop()
	})

	it('keeps the timer running when the line is cleared for other output', () => {
		const { lastLine, stream, writes } = createTerminal()
		const progress = createProgressLine(stream)
		progress.start('Researching')
		vi.advanceTimersByTime(5000)
		progress.clear()
		expect(writes.at(-1)).toBe(`\r${CLEAR_TO_LINE_END}`)
		vi.advanceTimersByTime(FRAME_INTERVAL_MS)
		expect(lastLine()).toContain('Researching [5s]')
		progress.stop()
	})

	it.each([80, 20, 12, 8, 4])('never wraps at %i columns', (columns) => {
		const { lastLine, stream } = createTerminal(columns)
		const progress = createProgressLine(stream)
		progress.start(LONG_MESSAGE)
		expect(lastLine().length).toBeLessThan(columns)
		progress.stop()
	})

	it('keeps the timer visible when it truncates the message', () => {
		const { lastLine, stream } = createTerminal(30)
		const progress = createProgressLine(stream)
		progress.start(LONG_MESSAGE)
		expect(lastLine().endsWith(' [0s]')).toBe(true)
		progress.stop()
	})

	it('follows terminal resizes', () => {
		const { lastLine, stream } = createTerminal(80)
		const progress = createProgressLine(stream)
		progress.start(LONG_MESSAGE)
		stream.columns = 30
		vi.advanceTimersByTime(FRAME_INTERVAL_MS)
		expect(lastLine().length).toBeLessThan(30)
		progress.stop()
	})

	it('shows the whole message when the terminal reports no width', () => {
		const { lastLine, stream } = createTerminal(0)
		const progress = createProgressLine(stream)
		progress.start(LONG_MESSAGE)
		expect(lastLine()).toContain(`${LONG_MESSAGE} [0s]`)
		progress.stop()
	})

	it('clears the line and restores the cursor once when stopped', () => {
		const { stream, writes } = createTerminal()
		const progress = createProgressLine(stream)
		progress.start('Researching')
		progress.stop()
		expect(writes.at(-1)).toBe(`\r${CLEAR_TO_LINE_END}${SHOW_CURSOR}`)

		const count = writes.length
		progress.stop()
		progress.clear()
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 5)
		expect(writes).toHaveLength(count)
	})

	it('restores the cursor if the process exits while running', () => {
		const { stream, writes } = createTerminal()
		const progress = createProgressLine(stream)
		const existing = new Set(process.listeners('exit'))
		progress.start('Researching')
		const added = process.listeners('exit').filter((listener) => !existing.has(listener))
		expect(added).toHaveLength(1)

		added[0]?.(0)
		expect(writes.at(-1)).toContain(SHOW_CURSOR)
		expect(process.listeners('exit')).toHaveLength(existing.size)
	})
})
