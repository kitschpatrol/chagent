import { describe, expect, it } from 'vitest'
import type { Evidence } from '../src/lib/types'
import { researchEvidence, splitEvidence } from '../src/lib/batches'

describe('evidence batching', () => {
	it.each(['source change\n', '\u{1}'])(
		'retains every changed character within the batch budget for %j',
		(fragment) => {
			const text = fragment.repeat(4000)
			const evidence: Evidence[] = [{ id: 'diff:source', kind: 'diff', text }]
			const batches = splitEvidence(evidence, 4000)
			expect(batches.length).toBeGreaterThan(1)
			for (const batch of batches) {
				expect(JSON.stringify(batch).length).toBeLessThanOrEqual(4000)
			}

			expect(
				batches
					.flat()
					.filter((item) => item.kind === 'diff')
					.map((item) => item.text)
					.join(''),
			).toBe(text)
		},
	)

	it('keeps the complete Git range available when starting evidence exceeds the budget', () => {
		const range: Evidence = {
			id: 'range:before..after',
			kind: 'range',
			text: 'Read the complete range with git log and git show.',
		}
		const evidence: Evidence[] = [
			range,
			{ id: 'large', kind: 'commit', text: 'Large commit body. '.repeat(1000) },
			{ id: 'small', kind: 'commit', text: 'Fix behavior.' },
		]
		const seed = researchEvidence(evidence, 4000)
		expect(seed).toContainEqual(range)
		expect(seed.map((item) => item.id)).toEqual([range.id, 'small'])
		expect(JSON.stringify(seed).length).toBeLessThanOrEqual(4000)
	})
})
