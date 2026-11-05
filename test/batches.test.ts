import { describe, expect, it } from 'vitest'
import type { Evidence, GenerationRequest } from '../src/lib/types'
import { historyBatches, researchEvidence } from '../src/lib/batches'

describe('evidence batching', () => {
	it('uses spare context budget for a large PR associated with one release', () => {
		const pull: Evidence = { id: 'pr:1', kind: 'pull-request', text: 'Details.'.repeat(350) }
		const requests: GenerationRequest[] = [0, 1].map((index) => ({
			evidence: [{ id: `range:${index}`, kind: 'range', text: 'Inspect this release.' }],
			existingEntries: '',
			packageName: 'example',
			repository: { directory: '.', excludeDirectories: [], root: '/example', to: 'head' },
			timeoutMs: 5000,
			version: `1.0.${index}`,
		}))
		requests[1]!.evidence.push(pull)
		const batches = historyBatches(requests, 4000)
		expect(batches).toHaveLength(1)
		expect(batches[0]![1]?.evidence).toContainEqual(pull)
		expect(JSON.stringify(batches[0]).length).toBeLessThanOrEqual(4000)
	})

	it.each([4000, 80_000])(
		'prioritizes release boundaries over optional seed evidence within %i characters',
		(limit) => {
			const requests: GenerationRequest[] = Array.from({ length: 22 }, (_, index) => ({
				evidence: [
					{ id: `range:${index}`, kind: 'range', text: 'Inspect the complete Git range.' },
					{ id: 'large', kind: 'commit', text: 'Large optional commit body. '.repeat(2000) },
					{ id: 'small', kind: 'commit', text: 'Fix behavior.' },
				],
				existingEntries: 'Preserve this human note.',
				packageName: 'example',
				repository: {
					directory: '.',
					excludeDirectories: [],
					from: `before-${index}`,
					root: '/example',
					to: `after-${index}`,
				},
				timeoutMs: 5000,
				version: `1.0.${index}`,
			}))
			const batches = historyBatches(requests, limit)
			expect(batches.length === 1).toBe(limit === 80_000)

			for (const batch of batches) {
				expect(JSON.stringify(batch).length).toBeLessThanOrEqual(limit)
			}

			for (const [index, release] of batches.flat().entries()) {
				expect(release.id).toBe(String(index))
				expect(release.repository).toEqual(requests[index]?.repository)
				expect(release.evidence[0]?.id).toBe(`range:${index}`)
				expect(release.existingEntries).toBe('Preserve this human note.')
			}
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
