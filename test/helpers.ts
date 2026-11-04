import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git } from '../src/lib/process'

/** Create an isolated Git repository with a committed initial version. */
export async function createRepository(files: Record<string, string> = {}): Promise<string> {
	const temporary = await mkdtemp(path.join(os.tmpdir(), 'chagent-test-'))
	const root = await realpath(temporary)
	await git(root, ['init', '--initial-branch=main'])
	await git(root, ['config', 'user.name', 'Changelog Test'])
	await git(root, ['config', 'user.email', 'changelog@example.invalid'])
	await git(root, ['config', 'commit.gpgsign', 'false'])
	await git(root, ['config', 'tag.gpgsign', 'false'])
	await git(root, ['config', 'core.hooksPath', path.join(root, '.git', 'no-hooks')])
	await writeFiles(root, {
		'index.js': 'export const answer = 42\n',
		'package.json': JSON.stringify({
			engines: { node: '>=18' },
			name: 'example',
			version: '1.0.0',
		}),
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
