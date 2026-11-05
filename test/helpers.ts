import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'
import type { Category, GenerationRequest, GenerationResponse } from '../src/lib/types'
import { git } from '../src/lib/process'

/**
 * Create an isolated Git repository with a committed initial version, removed
 * when the current test finishes.
 */
export async function createRepository(
	files: Record<string, string> = {},
	nodePackage = true,
): Promise<string> {
	const temporary = await mkdtemp(path.join(os.tmpdir(), 'chagent-test-'))
	onTestFinished(async () => {
		await rm(temporary, { force: true, recursive: true })
	})
	const root = await realpath(temporary)
	await git(root, ['init', '--initial-branch=main'])
	await git(root, ['config', 'user.name', 'Changelog Test'])
	await git(root, ['config', 'user.email', 'changelog@example.invalid'])
	await git(root, ['config', 'commit.gpgsign', 'false'])
	await git(root, ['config', 'tag.gpgsign', 'false'])
	await git(root, ['config', 'core.hooksPath', path.join(root, '.git', 'no-hooks')])
	const defaults: Record<string, string> = nodePackage
		? {
				'index.js': 'export const answer = 42\n',
				'package.json': JSON.stringify({
					engines: { node: '>=18' },
					name: 'example',
					version: '1.0.0',
				}),
			}
		: {}
	await writeFiles(root, {
		...defaults,
		...files,
	})
	await commit(root, 'Add initial implementation.')
	return root
}

/** Write fixture files, creating their parent directories. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
	for (const [name, content] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(root, name)), { recursive: true })
		await writeFile(path.join(root, name), content)
	}
}

/** Commit all fixture changes. */
export async function commit(root: string, message: string): Promise<void> {
	await git(root, ['add', '--all'])
	await git(root, ['commit', '-m', message])
}

/** Respond to an adapter request with one cited change for each release. */
export function describeReleases(
	request: GenerationRequest,
	category: Category = 'Changed',
): GenerationResponse {
	return {
		releases: request.releases.map((release) => ({
			changes: [
				{
					breaking: false,
					category,
					description: `Improve ${release.packageName} in ${release.version}.`,
					sources: [release.evidence[0]!.id],
				},
			],
			id: release.id,
		})),
	}
}
