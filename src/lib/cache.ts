import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readOptional } from './repository'

/** Fingerprint generation inputs and file contents. */
export function hash(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

/** Read disposable cached JSON, tolerating corruption and older formats. */
export async function readCache(directory: string, key: string): Promise<unknown> {
	try {
		const content = await readOptional(path.join(directory, `${hash(key)}.json`))
		return content === undefined ? undefined : (JSON.parse(content) as unknown)
	} catch {
		return undefined
	}
}

/** Atomically persist resumable metadata outside tracked project files. */
export async function writeCache(directory: string, key: string, value: unknown): Promise<void> {
	await mkdir(directory, { recursive: true })
	const file = path.join(directory, `${hash(key)}.json`)
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
	await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
	await rename(temporary, file)
}
