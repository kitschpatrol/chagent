import { describe, expect, it } from 'vitest'
import type { Change } from '../src/lib/types'
import {
	changelogHeader,
	mergeChanges,
	nodeExceptionNote,
	parseChangelog,
	updateMarkdown,
} from '../src/lib/changelog'

const change: Change = {
	breaking: false,
	category: 'Added',
	description: 'Support custom themes.',
	sources: ['commit'],
}

describe('changelog rendering', () => {
	it('creates the exact canonical header and only canonical categories', () => {
		const result = updateMarkdown(
			undefined,
			[{ changes: [change], release: { date: '2026-01-01', ref: 'abc', version: '1.0.0' } }],
			false,
		)
		expect(result).toBe(
			`${changelogHeader}\n## 1.0.0 - 2026-01-01\n\n### Added\n\n- Support custom themes.\n\n`,
		)
	})

	it('preserves historical Markdown byte for byte, including code fences', () => {
		const history =
			'## [1.0.0] - 2026-01-01\r\n\r\n### Fixed\r\n* Keep  this unusual formatting.\r\n\r\n```md\r\n## [9.0.0] - fake heading\r\n```\r\n\r\n'
		const original =
			changelogHeader.replaceAll('\n', '\r\n') +
			'\r\n' +
			history +
			'[1.0.0]: https://example.com/v1\r\n'
		const updated = updateMarkdown(
			original,
			[{ changes: [change], release: { date: '2026-02-01', ref: 'def', version: '1.1.0' } }],
			false,
		)
		expect(updated).toContain(history)
		expect(parseChangelog(updated).sections.map((section) => section.version)).toEqual([
			'1.1.0',
			'1.0.0',
		])
		expect(updated.endsWith('[1.0.0]: https://example.com/v1\r\n')).toBe(true)
	})

	it('promotes handwritten unreleased notes without duplicating them', () => {
		const original =
			changelogHeader + '\n## [Unreleased]\n\n### Added\n\n- Support custom themes.\n\n'
		const draft = parseChangelog(original).sections[0]!.body
		const result = updateMarkdown(
			original,
			[
				{
					changes: [change],
					existingBody: draft,
					release: { date: '2026-02-01', ref: 'def', version: '1.1.0' },
				},
			],
			false,
		)
		expect(result).not.toContain('## [Unreleased]')
		expect(result.match(/Support custom themes/gu)).toHaveLength(1)
	})

	it('adds the evidence-backed Node note only once', () => {
		const first = updateMarkdown(changelogHeader, [], true)
		expect(first).toContain(nodeExceptionNote)
		expect(updateMarkdown(first, [], true)).toBe(first)
	})

	it('adds bullets to their existing category without replacing human notes', () => {
		const body = '\n### Added\n\n- A handwritten note.\n\n### Fixed\n\n- A fix.\n\n'
		const result = mergeChanges(body, [change])
		expect(result).toContain('- A handwritten note.\n- Support custom themes.\n\n### Fixed')
		expect(result).toContain('- A fix.')
	})
})
