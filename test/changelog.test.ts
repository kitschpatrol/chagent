import { describe, expect, it } from 'vitest'
import type { Change } from '../src/lib/types'
import {
	changelogHeader,
	mergeChanges,
	nodeExceptionNote,
	parseChangelog,
	updateMarkdown,
} from '../src/lib/changelog'

const THEME_DESCRIPTION = /Support custom themes/gv

const change: Change = {
	breaking: false,
	category: 'Added',
	description: 'Support custom themes.',
	sources: ['commit'],
}

describe('changelog parsing', () => {
	it.each([
		['## [1.0.0](https://example.com/compare/v0.9.0...v1.0.0) (2026-01-01)'],
		['# [1.0.0](https://example.com/compare/v0.9.0...v1.0.0) (2026-01-01)'],
		['## 1.0.0 (2026-01-01)'],
		['# 1.0.0'],
		['## 1.0.0 / 2026-01-01'],
		['## v1.0.0 - 2026-01-01'],
		['## [1.0.0] - 2026-01-01'],
	])('recognizes the release heading %s', (heading) => {
		const { sections } = parseChangelog(`# Changelog\n\n${heading}\n\n- An entry.\n`)
		expect(sections.map((section) => section.version)).toEqual(['1.0.0'])
		expect(sections[0]?.heading.trim()).toBe(heading)
	})

	it.each([['## Release 1.0.0'], ['# Version 1.0.0 notes'], ['## Upgrading to 2.0.0']])(
		'rejects %s instead of treating it as text',
		(heading) => {
			expect(() => parseChangelog(`# Changelog\n\n${heading}\n`)).toThrow(
				'Unrecognized release heading',
			)
		},
	)

	it('rejects an unclosed code fence instead of hiding the headings after it', () => {
		expect(() => parseChangelog('# Changelog\n\n```\n\n## 1.0.0\n\n- An entry.\n')).toThrow(
			'Unclosed code fence',
		)
	})

	it('closes a fence only with a matching marker and no info string', () => {
		const content =
			'## 2.0.0\n\n```md\n```js\n## 9.0.0\n```\n\n~~~\n```\n## 8.0.0\n~~~\n\n````\n```\n## 7.0.0\n````\n\n## 1.0.0\n'
		expect(parseChangelog(content).sections.map((section) => section.version)).toEqual([
			'2.0.0',
			'1.0.0',
		])
	})

	it('leaves titles, lower headings, and fenced examples alone', () => {
		const content =
			'# Changelog for example\n\n### Upgrading to 2.0.0\n\n```md\n## Release 1.0.0\n```\n'
		expect(parseChangelog(content).sections).toEqual([])
	})
})

describe('changelog rendering', () => {
	it('creates the exact canonical header', () => {
		const result = updateMarkdown(
			undefined,
			[{ changes: [change], release: { date: '2026-01-01', ref: 'abc', version: '1.0.0' } }],
			false,
		)
		expect(result).toBe(
			`${changelogHeader}\n## 1.0.0 - 2026-01-01\n\n### Added\n\n- Support custom themes.\n`,
		)
	})

	it.each([
		['a new draft', undefined, 'Unreleased', '\n'],
		['a new release', undefined, '1.0.0', '\n'],
		['an existing draft', `${changelogHeader}\n## Unreleased\n\n- Old.\n\n\n`, 'Unreleased', '\n'],
		[
			'a CRLF changelog',
			changelogHeader.replaceAll('\n', '\r\n') + '\r\n## Unreleased\r\n\r\n- Old.\r\n\r\n',
			'Unreleased',
			'\r\n',
		],
	])('ends the file with one newline after writing %s', (_label, original, version, newline) => {
		const result = updateMarkdown(
			original,
			[{ changes: [change], release: { ref: 'abc', version } }],
			false,
		)
		expect(result.endsWith(`- Support custom themes.${newline}`)).toBe(true)
	})

	it('separates a draft that ended the file from a section added below it', () => {
		const result = updateMarkdown(
			`${changelogHeader}\n## Unreleased\n\n- Keep this draft.\n`,
			[{ changes: [change], release: { ref: 'abc', version: '1.0.0' } }],
			false,
		)
		expect(result).toContain('- Keep this draft.\n\n## 1.0.0\n')
		expect(parseChangelog(result).sections.map((section) => section.version)).toEqual([
			'Unreleased',
			'1.0.0',
		])
	})

	it('keeps documentation and maintenance notes in their headings when promoting a draft', () => {
		const history = '## 1.0.0 - 2026-01-01\n\n### Changed\n\n* Keep this historical entry.\n\n'
		const draft =
			'\n### Documentation\n\n- Preserve this handwritten guide.\n\n### Maintenance\n\n- Refresh test tooling.\n\n'
		const original = changelogHeader + '\n## Unreleased\n' + draft + history
		const result = updateMarkdown(
			original,
			[
				{
					changes: [
						{ ...change, category: 'Documentation', description: 'Correct the API example.' },
						{ ...change, category: 'Maintenance', description: 'Refresh test tooling.' },
						{ ...change, category: 'Maintenance', description: 'Add a CI workflow.' },
					],
					existingBody: draft,
					release: { date: '2026-02-01', ref: 'def', version: '1.1.0' },
				},
			],
			false,
		)
		expect(result).toBe(
			changelogHeader +
				'\n## 1.1.0 - 2026-02-01\n\n### Documentation\n\n- Preserve this handwritten guide.\n- Correct the API example.\n\n### Maintenance\n\n- Refresh test tooling.\n- Add a CI workflow.\n\n' +
				history,
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
		expect(result.match(THEME_DESCRIPTION)).toHaveLength(1)
	})

	it('adds the evidence-backed Node note only once', () => {
		const first = updateMarkdown(changelogHeader, [], true)
		expect(first).toContain(nodeExceptionNote)
		expect(updateMarkdown(first, [], true)).toBe(first)
	})

	it('drops the Unreleased comparison link when the draft is promoted', () => {
		const original =
			changelogHeader +
			'\n## [Unreleased]\n\n### Fixed\n\n- A draft note.\n\n## [1.0.0] - 2026-01-01\n\n- First.\n\n' +
			'[Unreleased]: https://github.com/example/repo/compare/v1.0.0...HEAD\n' +
			'[1.0.0]: https://github.com/example/repo/releases/tag/v1.0.0\n'
		const result = updateMarkdown(
			original,
			[
				{
					changes: [change],
					existingBody: parseChangelog(original).sections[0]!.body,
					release: {
						date: '2026-02-01',
						previousTag: 'v1.0.0',
						ref: 'def',
						tag: 'v1.1.0',
						version: '1.1.0',
					},
				},
			],
			false,
			'example/repo',
		)
		expect(result).not.toContain('[Unreleased]')
		expect(
			result.endsWith(
				'[1.0.0]: https://github.com/example/repo/releases/tag/v1.0.0\n[1.1.0]: https://github.com/example/repo/compare/v1.0.0...v1.1.0\n',
			),
		).toBe(true)
	})

	it.each([
		[
			'before a later category',
			'\n### Maintenance\n\n- Tidy.\n',
			'Added',
			['Added', 'Maintenance'],
		],
		[
			'between categories',
			'\n### Added\n\n- New.\n\n### Maintenance\n\n- Tidy.\n',
			'Fixed',
			['Added', 'Fixed', 'Maintenance'],
		],
		[
			'after earlier categories',
			'\n### Added\n\n- New.\n',
			'Maintenance',
			['Added', 'Maintenance'],
		],
	] as const)('inserts a new category %s', (_label, body, category, order) => {
		const result = mergeChanges(body, [{ ...change, category }])
		expect(
			result
				.matchAll(/^### (\w+)$/gmv)
				.map((match) => match[1])
				.toArray(),
		).toEqual(order)
		expect(result).toContain(`### ${category}\n\n- Support custom themes.\n\n`)
	})

	it('adds bullets to their existing category without replacing human notes', () => {
		const body = '\n### Added\n\n- A handwritten note.\n\n### Fixed\n\n- A fix.\n\n'
		const result = mergeChanges(body, [change])
		expect(result).toContain('- A handwritten note.\n- Support custom themes.\n\n### Fixed')
		expect(result).toContain('- A fix.')
	})
})
