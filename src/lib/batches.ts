import type { Evidence, ReleaseRequest } from './types'

/**
 * Keep release boundaries together, trimming optional seed evidence before
 * splitting history.
 */
export function releaseBatches(requests: ReleaseRequest[], limit: number): ReleaseRequest[][] {
	const full = new Map(requests.map((request) => [request.id, request.evidence]))
	const batches: ReleaseRequest[][] = []
	let batch: ReleaseRequest[] = []
	let size = 2
	for (const release of requests) {
		const minimum = {
			...release,
			evidence: release.evidence.filter((item) => required(item)),
		}
		const length = JSON.stringify(minimum).length + 1
		if (size + length > limit && batch.length > 0) {
			batches.push(batch)
			batch = []
			size = 2
		}

		batch.push(minimum)
		size += length
	}

	if (batch.length > 0) {
		batches.push(batch)
	}

	return batches.map((items) => {
		const allowance = Math.max(0, Math.floor((limit - JSON.stringify(items).length) / items.length))
		const seeded = items.map((item) => ({
			...item,
			evidence: [
				...item.evidence,
				...researchEvidence(
					full.get(item.id)!.filter((entry) => !required(entry)),
					allowance + 2,
				),
			],
		}))
		// Let larger PRs and commits use space that quieter releases did not need.
		let remaining = limit - JSON.stringify(seeded).length
		for (const item of seeded) {
			const supplied = new Set(item.evidence.map((entry) => entry.id))
			const optional = full.get(item.id)!.filter((entry) => !supplied.has(entry.id))
			const before = JSON.stringify(item.evidence).length
			item.evidence.push(...researchEvidence(optional, remaining + 2))
			remaining -= JSON.stringify(item.evidence).length - before
		}

		return seeded
	})
}

/** Keep what a request cannot do without: its range, and a draft it may cite. */
function required(item: Evidence): boolean {
	return item.kind === 'range' || item.kind === 'draft'
}

/** Bound the starting context; adapters can read the complete range themselves. */
export function researchEvidence(evidence: Evidence[], limit: number): Evidence[] {
	const seed: Evidence[] = []
	let size = 2
	for (const item of evidence) {
		const length = JSON.stringify(item).length + 1
		if (size + length > limit) {
			continue
		}

		seed.push(item)
		size += length
	}

	return seed
}
