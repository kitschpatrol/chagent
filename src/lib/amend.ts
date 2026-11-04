import path from 'node:path'
import type { ChangelogPlan } from './types'
import { git, runCommand } from './process'
import { inspectRepository, isVersionOnlyChange, manifestAt } from './repository'
import { writeChangelog } from './write'

type Tag = { contents?: string; name: string; object: string }
const SIGNATURE = /-----BEGIN (?:PGP|SSH) SIGNATURE-----/v
const RELEASE_MESSAGE = /^(?:release\b|(?:chore|build)(?:\(release\))?:?\s*(?:release\b|v?\d))/iv
const LOCKFILE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/v

async function assertUnpublished(root: string, head: string, tags: Tag[]): Promise<void> {
	const remotes = await git(root, ['remote'])
	for (const remote of remotes.split('\n')) {
		if (remote === '') {
			continue
		}

		const refs = await git(root, ['ls-remote', '--heads', '--tags', remote])
		for (const line of refs.split('\n')) {
			const [object, ref] = line.split('\t', 2)
			if (object === undefined || ref === undefined) {
				continue
			}

			if (object === head || tags.some((tag) => ref === `refs/tags/${tag.name}`)) {
				throw new Error(`The release is already advertised by ${remote}; refusing to amend it.`)
			}

			if (!ref.startsWith('refs/heads/')) {
				continue
			}

			const known = await runCommand('git', ['cat-file', '-e', object + '^{commit}'], {
				allowFailure: true,
				cwd: root,
			})
			if (known.code !== 0) {
				throw new Error(
					`Cannot verify unpublished status against ${remote}. Fetch its branches and retry.`,
				)
			}

			const contains = await runCommand('git', ['merge-base', '--is-ancestor', head, object], {
				allowFailure: true,
				cwd: root,
			})
			if (contains.code === 0) {
				throw new Error(
					`The release commit is already reachable on ${remote}; refusing to amend it.`,
				)
			}
		}
	}
}

async function inspectRelease(plan: ChangelogPlan): Promise<Tag[]> {
	const { head, root } = plan
	if ((await git(root, ['rev-parse', 'HEAD'])) !== head) {
		throw new Error('HEAD changed during generation; refusing to amend.')
	}

	if ((await git(root, ['symbolic-ref', '-q', 'HEAD'], true)) === '') {
		throw new Error('Amendment requires a checked-out branch.')
	}

	const parents = await git(root, ['rev-list', '--parents', '-n', '1', head])
	if (parents.split(' ').length !== 2) {
		throw new Error('Amendment requires a release commit with exactly one parent.')
	}

	const subject = await git(root, ['log', '-1', '--format=%s'])
	if (!RELEASE_MESSAGE.test(subject)) {
		throw new Error(
			'HEAD does not have a recognizable release commit message. Use the bumpp hook for automatic release integration.',
		)
	}

	await assertVersionBump(root, head)

	const repository = await inspectRepository(root)
	const versions = [repository.rootPackage, ...repository.packages]
		.map((pkg) => pkg.version)
		.filter((version) => version !== undefined)
	const names = await git(root, ['tag', '--points-at', head])
	const tags: Tag[] = []
	for (const name of names.split('\n')) {
		if (name === '') {
			continue
		}

		if (
			versions.every(
				(version) =>
					name !== version &&
					name !== `v${version}` &&
					!name.endsWith(`@${version}`) &&
					!name.endsWith(`/v${version}`),
			)
		) {
			throw new Error(`HEAD also has an unrelated tag (${name}); refusing to move it.`)
		}

		const object = await git(root, ['rev-parse', `refs/tags/${name}`])
		const contents = await tagContents(root, object)
		if (contents !== undefined && SIGNATURE.test(contents)) {
			throw new Error(
				`Tag ${name} is signed. Use the bumpp hook before tagging, or re-sign this release manually.`,
			)
		}

		tags.push({ contents, name, object })
	}

	await assertUnpublished(root, head, tags)
	return tags
}

async function tagContents(root: string, object: string): Promise<string | undefined> {
	if ((await git(root, ['cat-file', '-t', object])) !== 'tag') {
		return undefined
	}

	const result = await runCommand('git', ['cat-file', '-p', object], { cwd: root })
	return result.stdout
}

/**
 * Explicitly amend an unpublished version-only release and its matching local
 * tags.
 */
export async function amendRelease(plan: ChangelogPlan): Promise<string> {
	const tags = await inspectRelease(plan)
	const files = await writeChangelog(plan)
	if (files.length === 0) {
		return plan.head
	}

	if ((await git(plan.root, ['rev-parse', 'HEAD'])) !== plan.head) {
		throw new Error('HEAD changed while writing changelogs; refusing to amend.')
	}

	const originalCommit = await git(plan.root, ['cat-file', '-p', plan.head])
	await git(plan.root, ['add', '--', ...files])
	await git(plan.root, [
		'commit',
		'--amend',
		'--no-edit',
		'--only',
		...(originalCommit.includes('\ngpgsig ') ? ['--gpg-sign'] : []),
		'--',
		...files,
	])
	const amended = await git(plan.root, ['rev-parse', 'HEAD'])
	try {
		const updates: string[] = ['start']
		for (const tag of tags) {
			let object = amended
			if (tag.contents !== undefined) {
				const contents = tag.contents.replace(`object ${plan.head}`, () => `object ${amended}`)
				const result = await runCommand('git', ['mktag'], { cwd: plan.root, input: contents })
				object = result.stdout.trim()
			}

			updates.push(`update refs/tags/${tag.name} ${object} ${tag.object}`)
		}

		updates.push('prepare', 'commit')
		await runCommand('git', ['update-ref', '--stdin'], {
			cwd: plan.root,
			input: updates.join('\n') + '\n',
		})
	} catch (error) {
		await git(plan.root, ['update-ref', 'HEAD', plan.head, amended])
		throw new Error(
			'Could not retarget the release tags. Restored the original release commit; changelog edits remain available.',
			{ cause: error },
		)
	}

	return amended
}

async function assertVersionBump(root: string, head: string): Promise<void> {
	const files = await git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', head])
	let versionChanged = false
	for (const file of files.split('\n')) {
		if (path.basename(file).toLowerCase() === 'changelog.md' || LOCKFILE.test(file)) {
			continue
		}

		if (path.basename(file) !== 'package.json') {
			throw new Error(
				`The release commit also changes ${file}; automatic amendment requires a version-only release commit.`,
			)
		}

		const before = await manifestAt(root, path.posix.dirname(file), head + '^')
		const after = await manifestAt(root, path.posix.dirname(file), head)
		if (before === undefined || after === undefined || before.version === after.version) {
			throw new Error(`No verifiable version bump in ${file}.`)
		}

		if (!(await isVersionOnlyChange(root, file, head + '^', head))) {
			throw new Error(
				`The release changes more than the version in ${file}. Use the bumpp hook instead.`,
			)
		}

		versionChanged = true
	}

	if (!versionChanged) {
		throw new Error('HEAD does not contain a version bump.')
	}
}
