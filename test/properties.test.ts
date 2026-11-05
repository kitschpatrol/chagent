import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Change, Evidence, ReleaseRequest } from '../src/lib/types'
import { releaseBatches } from '../src/lib/batches'
import { mergeChanges, parseChangelog, updateMarkdown } from '../src/lib/changelog'
import { categories } from '../src/lib/types'

const WHITESPACE_RUN = /\s+/gv
const FINAL_PERIOD = /\.$/v

const version = fc
	.tuple(fc.nat(30), fc.nat(30), fc.nat(30))
	.map(([major, minor, patch]) => `${major}.${minor}.${patch}`)

const releaseHeading = (value: string) =>
	fc.constantFrom(
		`## ${value}`,
		`## v${value} - 2026-01-01`,
		`## [${value}] - 2026-01-01`,
		`## [${value}](https://example.com/${value}) (2026-01-01)`,
		`# ${value}`,
	)

const looseText = fc
	.string()
	.filter(
		(text) => !text.includes('\n') && !text.includes('\r') && !text.trimStart().startsWith('#'),
	)

const bodyLine = fc.oneof(
	fc.constantFrom(
		'',
		'### Added',
		'### Custom heading',
		'- An entry.',
		'* A   handwritten  entry.',
		'[1.0.0]: https://example.com/1.0.0',
	),
	looseText,
)

const sectionBody = fc
	.array(
		fc.oneof(
			bodyLine.map((line) => [line]),
			fc.constantFrom(
				['```md', '## [9.9.9] - An example heading', '```'],
				['~~~', '# 8.8.8', '```', '~~~'],
			),
		),
		{ maxLength: 5 },
	)
	.map((blocks) => blocks.flat())

/**
 * Changelogs with unique release headings, unusual bodies, and either line
 * ending.
 */
const changelog = fc
	.tuple(
		sectionBody,
		fc
			.uniqueArray(version, { maxLength: 5 })
			.chain((versions) =>
				fc.tuple(...versions.map((value) => fc.tuple(releaseHeading(value), sectionBody))),
			),
		fc.constantFrom('\n', '\r\n'),
		fc.boolean(),
	)
	.map(([preamble, sections, newline, trailingNewline]) => {
		const lines = [...preamble, ...sections.flatMap(([heading, body]) => [heading, ...body])]
		return lines.join(newline) + (trailingNewline ? newline : '')
	})

const change: fc.Arbitrary<Change> = fc.record({
	breaking: fc.boolean(),
	category: fc.constantFrom(...categories),
	description: fc.constantFrom(
		'Add a feature.',
		'add  A feature',
		'Fix the parser.',
		'Refresh tooling.',
		'Document the API',
	),
	sources: fc.constant(['commit']),
})

describe('changelog parsing properties', () => {
	it('accounts for every byte of the input', () => {
		fc.assert(
			fc.property(changelog, (content) => {
				const { footer, header, sections } = parseChangelog(content)
				const body = sections.map((section) => section.heading + section.body).join('')
				expect(header + body + footer).toBe(content)
				for (const section of sections) {
					expect(content.slice(section.start, section.end)).toBe(section.heading + section.body)
				}
			}),
		)
	})

	it('leaves a changelog untouched when there is nothing to add', () => {
		fc.assert(
			fc.property(changelog, (content) => {
				expect(updateMarkdown(content, [], false)).toBe(content)
			}),
		)
	})

	it('preserves every historical section when adding a release', () => {
		fc.assert(
			fc.property(changelog, fc.array(change, { maxLength: 4 }), (content, changes) => {
				const release = { date: '2026-02-01', ref: 'abc', version: '99.0.0' }
				const updated = updateMarkdown(content, [{ changes, release }], false)
				const { sections } = parseChangelog(content)
				for (const section of sections) {
					expect(updated).toContain(content.slice(section.start, section.end))
				}

				expect(parseChangelog(updated).sections.map((section) => section.version)).toEqual([
					'99.0.0',
					...sections.map((section) => section.version),
				])
			}),
		)
	})
})

/** Duplicate detection ignores case, spacing, and a final period. */
function comparable(text: string): string {
	return text.toLowerCase().replaceAll(WHITESPACE_RUN, ' ').trim().replace(FINAL_PERIOD, '')
}

describe('draft merging properties', () => {
	it('adds nothing the second time', () => {
		fc.assert(
			fc.property(
				fc.array(bodyLine, { maxLength: 8 }),
				fc.array(change, { maxLength: 6 }),
				(lines, changes) => {
					const once = mergeChanges(lines.join('\n'), changes)
					expect(mergeChanges(once, changes)).toBe(once)
				},
			),
		)
	})

	it('keeps every existing line and every new description', () => {
		fc.assert(
			fc.property(
				fc.array(bodyLine, { maxLength: 8 }),
				fc.array(change, { maxLength: 6 }),
				(lines, changes) => {
					const merged = mergeChanges(lines.join('\n'), changes)
					for (const line of lines) {
						expect(merged).toContain(line.trimEnd())
					}

					for (const { description } of changes) {
						expect(comparable(merged)).toContain(comparable(description))
					}
				},
			),
		)
	})
})

describe('release batching properties', () => {
	const evidenceItem: fc.Arbitrary<Evidence> = fc.record({
		id: fc.uuid(),
		kind: fc.constantFrom('commit', 'pull-request', 'manifest'),
		text: fc.string({ maxLength: 3000 }),
	})

	const requests = fc
		.array(fc.array(evidenceItem, { maxLength: 6 }), { minLength: 1, maxLength: 12 })
		.map((items): ReleaseRequest[] =>
			items.map((evidence, index) => ({
				evidence: [
					{ id: `range:${index}`, kind: 'range', text: 'Research this range.' },
					...evidence,
				],
				existingEntries: '',
				id: `.@1.0.${index}`,
				initialRelease: false,
				mode: 'update',
				packageName: 'example',
				repository: { directory: '.', excludeDirectories: [], to: `ref-${index}` },
				scope: 'package',
				version: `1.0.${index}`,
			})),
		)

	it('keeps every release in order, within budget, with its range and only its own evidence', () => {
		fc.assert(
			fc.property(requests, fc.integer({ min: 4000, max: 40_000 }), (input, limit) => {
				const batches = releaseBatches(input, limit)
				const output = batches.flat()
				expect(output.map((release) => release.id)).toEqual(input.map((release) => release.id))
				for (const batch of batches) {
					expect(JSON.stringify(batch).length).toBeLessThanOrEqual(limit)
				}

				for (const [index, release] of output.entries()) {
					const original = new Set(input[index]!.evidence.map((item) => item.id))
					const ids = release.evidence.map((item) => item.id)
					expect(ids[0]).toBe(`range:${index}`)
					expect(new Set(ids).size).toBe(ids.length)
					expect(ids.every((id) => original.has(id))).toBe(true)
				}
			}),
		)
	})
})
