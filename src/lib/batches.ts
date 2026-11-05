import type { Evidence, GenerationRequest, HistoryRelease } from './types'

/**
 * Keep release boundaries together, trimming optional seed evidence before
 * splitting history.
 */
export function historyBatches(requests: GenerationRequest[], limit: number): HistoryRelease[][] {
	const full = requests.map((request, index) => {
		const {
			effort: _effort,
			model: _model,
			signal: _signal,
			timeoutMs: _timeout,
			...input
		} = request
		return { ...input, id: String(index) }
	})
	const batches: HistoryRelease[][] = []
	let batch: HistoryRelease[] = []
	let size = 2
	for (const release of full) {
		const minimum = {
			...release,
			evidence: release.evidence.filter((item) => item.kind === 'range'),
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
					full[Number(item.id)]!.evidence.filter((entry) => entry.kind !== 'range'),
					allowance + 2,
				),
			],
		}))
		// Let larger PRs and commits use space that quieter releases did not need.
		let remaining = limit - JSON.stringify(seeded).length
		for (const item of seeded) {
			const supplied = new Set(item.evidence.map((entry) => entry.id))
			const optional = full[Number(item.id)]!.evidence.filter((entry) => !supplied.has(entry.id))
			const before = JSON.stringify(item.evidence).length
			item.evidence.push(...researchEvidence(optional, remaining + 2))
			remaining -= JSON.stringify(item.evidence).length - before
		}

		return seeded
	})
}

/**
 * Bound the starting context; research adapters can read the complete range
 * themselves.
 */
export function researchEvidence(evidence: Evidence[], limit: number): Evidence[] {
	const seed: Evidence[] = []
	let size = 2
	for (const item of evidence) {
		const length = JSON.stringify(item).length + 1
		if (!(size + length <= limit)) {
			continue
		}

		seed.push(item)
		size += length
	}

	return seed
}
