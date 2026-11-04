import { readdir } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import type { Change, Release } from './types'
import { readOptional } from './repository'
import { categories } from './types'

export const changelogHeader =
	'# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),\nand this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n'
export const nodeExceptionNote =
	'(Node.js support requirements have sometimes increased in minor or patch releases.)'

type Section = { body: string; end: number; heading: string; start: number; version: string }
type Changelog = { footer: string; header: string; newline: string; sections: Section[] }

/** Find an existing changelog without creating a competing capitalization. */
export async function findChangelog(
	directory: string,
): Promise<{ content?: string; path: string }> {
	const names = await readdir(directory)
	const files = names.filter((file) => file.toLowerCase() === 'changelog.md')
	if (files.length > 1) {
		throw new Error(`Multiple changelog files in ${directory}; choose one capitalization.`)
	}

	const file = path.join(directory, files[0] ?? 'changelog.md')
	return { content: await readOptional(file), path: file }
}

/** Locate release sections while leaving the original Markdown bytes intact. */
export function parseChangelog(content: string): Changelog {
	const newline = content.includes('\r\n') ? '\r\n' : '\n'
	const sections: Section[] = []
	let offset = 0
	let fence = ''
	let footerStart = content.length
	for (const line of content.split(/(?<=\n)/v)) {
		const marker = /^\s{0,3}(`{3,}|~{3,})/v.exec(line)?.[1]
		if (marker !== undefined) {
			if (fence === '') {
				fence = marker
			} else if (marker.startsWith(fence)) {
				fence = ''
			}
		} else if (fence === '') {
			const match = /^## (?:\[([^\]]+)\](?:\([^\)]*\))?|([^\s]+))(?:\s+[\-–—].*)?\s*$/v.exec(
				line.trimEnd(),
			)
			if (match) {
				const raw = match[1] ?? match[2]!
				const version =
					raw.toLowerCase() === 'unreleased' ? 'Unreleased' : (semver.valid(raw) ?? raw)
				if (sections.some((section) => section.version === version)) {
					throw new Error(`Duplicate changelog section: ${version}`)
				}

				sections.push({ body: '', end: content.length, heading: line, start: offset, version })
				footerStart = content.length
			} else if (
				/^\[[^\]]+\]:\s+\S/v.test(line) &&
				sections.length > 0 &&
				footerStart === content.length
			) {
				footerStart = offset
			}
		}

		offset += line.length
	}

	for (let index = 0; index < sections.length; index++) {
		const section = sections[index]!
		section.end = sections[index + 1]?.start ?? footerStart
		section.body = content.slice(section.start + section.heading.length, section.end)
	}

	return {
		footer: content.slice(footerStart),
		header: content.slice(0, sections[0]?.start ?? content.length),
		newline,
		sections,
	}
}

function normalized(description: string): string {
	return description.trim().toLowerCase().replaceAll(/\s+/gv, ' ').replace(/[.!]$/v, '')
}

/** Add generated bullets to a draft while preserving existing human text. */
export function mergeChanges(body: string, changes: Change[], newline = '\n'): string {
	let result = body
	const seen = new Set(
		body
			.split(/\r?\n/v)
			.filter((line) => /^\s*[\-*] /v.test(line))
			.map((line) => normalized(line.replace(/^\s*[\-*] /v, ''))),
	)
	for (const category of categories) {
		const descriptions: string[] = []
		for (const change of changes) {
			if (change.category !== category) {
				continue
			}
			const description = (change.breaking ? '**Breaking:** ' : '') + change.description
			if (seen.has(normalized(description))) {
				continue
			}

			descriptions.push(`- ${description}`)
			seen.add(normalized(description))
		}

		if (descriptions.length === 0) {
			continue
		}

		const heading = new RegExp(String.raw`^### ${category}\s*$`, 'mv').exec(result)
		if (heading) {
			const after = heading.index + heading[0].length
			const next = /^### /mv.exec(result.slice(after))
			const end = next === null ? result.length : after + next.index
			const block =
				result.slice(0, end).trimEnd() + newline + descriptions.join(newline) + newline + newline
			result = block + result.slice(end)
		} else {
			result =
				result.trimEnd() +
				newline +
				newline +
				`### ${category}` +
				newline +
				newline +
				descriptions.join(newline) +
				newline +
				newline
		}
	}

	return result
}

/** Render a release heading with an optional comparison link. */
export function releaseLink(github: string | undefined, release: Release): string | undefined {
	if (github === undefined) {
		return undefined
	}

	const base = `https://github.com/${github}`
	if (release.version === 'Unreleased') {
		return release.previousTag === undefined
			? undefined
			: `${base}/compare/${encodeURIComponent(release.previousTag)}...HEAD`
	}

	if (release.tag === undefined) {
		return undefined
	}

	return release.previousTag === undefined
		? `${base}/releases/tag/${encodeURIComponent(release.tag)}`
		: `${base}/compare/${encodeURIComponent(release.previousTag)}...${encodeURIComponent(release.tag)}`
}

/** Insert new sections and update only the draft and its comparison link. */
export function updateMarkdown(
	original: string | undefined,
	entries: Array<{ changes: Change[]; existingBody?: string; release: Release }>,
	nodeException: boolean,
	github?: string,
): string {
	const content = original ?? changelogHeader
	const parsed = parseChangelog(content)
	const { newline } = parsed
	let { header } = parsed
	if (nodeException && !header.includes(nodeExceptionNote)) {
		const semverLine = /^.*\[Semantic Versioning\].*(?:\r?\n|$)/mv.exec(header)
		if (semverLine) {
			const index = semverLine.index + semverLine[0].length
			header =
				header.slice(0, index).trimEnd() +
				newline +
				newline +
				nodeExceptionNote +
				newline +
				header.slice(index)
		}
	}

	const additions: string[] = []
	const definitions: string[] = []
	let { footer } = parsed
	const draft = parsed.sections.find((section) => section.version === 'Unreleased')
	const released = parsed.sections
		.filter((section) => section.version !== 'Unreleased')
		.map((section) => content.slice(section.start, section.end))
	let draftText = draft === undefined ? '' : content.slice(draft.start, draft.end)
	for (const { changes, existingBody, release } of entries) {
		const link = releaseLink(github, release)
		const title = link === undefined ? release.version : `[${release.version}]`
		const heading = `## ${title}${release.date === undefined ? '' : ` - ${release.date}`}`
		let body = mergeChanges(existingBody ?? '', changes, newline)
		if (body.trim() === '') {
			if (release.version === 'Unreleased') {
				continue
			}

			body = `${newline}No notable changes.${newline}`
		}

		const section = heading + newline + newline + body.trim() + newline + newline
		if (release.version === 'Unreleased') {
			draftText = section
		} else {
			additions.push(section)
			if (existingBody !== undefined) {
				draftText = ''
			}
		}

		if (link !== undefined) {
			const definition = `[${release.version}]: ${link}`
			if (release.version === 'Unreleased') {
				footer = footer.replace(/^\[unreleased\]:[^\r\n]*(?:\r?\n)?/imv, '')
				definitions.unshift(definition)
			} else if (
				!new RegExp(
					String.raw`^\[${RegExp.escape(release.version)}\]:`,
					'imv',
				).test(footer)
			) {
				definitions.push(definition)
			}
		}
	}

	if (entries.length === 0 && header === parsed.header) {
		return content
	}

	const prefix = header.trimEnd() + newline + newline
	let result = prefix + draftText + additions.toReversed().join('') + released.join('')
	if (footer !== '' || definitions.length > 0) {
		result = result.trimEnd() + newline + newline + footer
		if (definitions.length > 0) {
			result = result.trimEnd() + newline + definitions.join(newline) + newline
		}
	}

	return result
}
