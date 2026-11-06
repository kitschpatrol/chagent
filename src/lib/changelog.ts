import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import type { Category, Change, Release } from './types'
import { parseVersion, readOptional } from './repository'
import { categories } from './types'

export const LINE_BOUNDARY = /(?<=\n)/v
const FENCE = /^\s{0,3}(`{3,}|~{3,})/v
const RELEASE_HEADING =
	/^(#{1,3}) (?:\[([^\]]+)\](?:\([^\)]*\))?|(\S+))(?:\s+(?:[\-–—\/].*|\(.*\)))?$/v
const TOP_LEVEL_HEADING = /^#{1,2}\s/v
const VERSION_NUMBER = /\d+\.\d+\.\d+/v
const REFERENCE = /^\[[^\]]+\]:\s+\S/v
const WHITESPACE = /\s+/gv
const TERMINAL_PUNCTUATION = /[.!]$/v
const NEWLINE = /\r?\n/v
const BULLET = /^\s*[\-*] /v
const ENTRY = /^\s*[\-*] /mv
const STYLE_REFERENCE_LENGTH = 2000
const CATEGORY_HEADING = /^### /mv
const SEMVER_LINE = /^.*\[Semantic Versioning\].*(?:\r?\n|$)/mv
const UNRELEASED_REFERENCE = /^\[unreleased\]:[^\r\n]*(?:\r?\n)?/imv
const V_PREFIX = /^v\d/v

export const changelogHeader =
	'# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),\nand this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n'
/** The body of a release section without any changes to record. */
export const noNotableChanges = 'No notable changes.'
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
	if (files.length > 0) {
		const metadata = await lstat(file)
		if (metadata.isSymbolicLink()) {
			throw new Error(`Changelog destination is not a regular file: ${file}`)
		}
	}

	return { content: await readOptional(file), path: file }
}

/**
 * Track the open code fence; only a matching marker with no info string closes
 * it.
 */
function nextFence(line: string, fence: string): string {
	const match = FENCE.exec(line)
	if (match === null) {
		return fence
	}

	const marker = match[1]!
	if (fence === '') {
		return marker
	}

	return marker.startsWith(fence) && line.slice(match[0].length).trim() === '' ? '' : fence
}

/** Locate release sections while leaving the original Markdown bytes intact. */
export function parseChangelog(content: string): Changelog {
	const newline = content.includes('\r\n') ? '\r\n' : '\n'
	const sections: Section[] = []
	let offset = 0
	let fence = ''
	let footerStart = content.length
	for (const line of content.split(LINE_BOUNDARY)) {
		const isFenceLine = FENCE.test(line)
		fence = nextFence(line, fence)
		if (!isFenceLine && fence === '') {
			const version = releaseHeadingVersion(line)
			if (version !== undefined) {
				if (sections.some((section) => section.version === version)) {
					throw new Error(`Duplicate changelog section: ${version}`)
				}

				sections.push({ body: '', end: content.length, heading: line, start: offset, version })
				footerStart = content.length
			} else if (TOP_LEVEL_HEADING.test(line) && VERSION_NUMBER.test(line)) {
				throw new Error(
					`Unrecognized release heading: "${line.trim()}". Use a heading such as "## [1.2.3] - 2026-01-01", or demote it below level two.`,
				)
			} else if (REFERENCE.test(line) && sections.length > 0 && footerStart === content.length) {
				footerStart = offset
			}
		}

		offset += line.length
	}

	if (fence !== '') {
		throw new Error(
			`Unclosed code fence (${fence}) in the changelog; it hides any release headings after it. Close the fence before updating.`,
		)
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

/**
 * Pick the newest release section with entries, to show an agent how this
 * changelog is written. Long sections are cut at a line boundary.
 */
export function styleReference({ sections }: Changelog): string | undefined {
	const section = sections.find(({ body, version }) => version !== 'Unreleased' && ENTRY.test(body))
	if (section === undefined) {
		return undefined
	}

	const lines = section.body.trim().split(LINE_BOUNDARY)
	let sample = ''
	for (const line of lines) {
		if (sample.length + line.length > STYLE_REFERENCE_LENGTH) {
			break
		}

		sample += line
	}

	return sample.trim() === '' ? undefined : sample.trimEnd()
}

function normalized(description: string): string {
	return description
		.trim()
		.toLowerCase()
		.replaceAll(WHITESPACE, ' ')
		.replace(TERMINAL_PUNCTUATION, '')
}

/** Add generated bullets to a draft while preserving existing human text. */
export function mergeChanges(body: string, changes: Change[], newline = '\n'): string {
	let result = body
	const seen = new Set(
		body
			.split(NEWLINE)
			.filter((line) => BULLET.test(line))
			.map((line) => normalized(line.replace(BULLET, ''))),
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

		const heading = categoryHeading(result, category)
		if (heading) {
			const after = heading.index + heading[0].length
			const next = CATEGORY_HEADING.exec(result.slice(after))
			const end = next === null ? result.length : after + next.index
			const block =
				result.slice(0, end).trimEnd() + newline + descriptions.join(newline) + newline + newline
			result = block + result.slice(end)
			continue
		}

		const block =
			`### ${category}` + newline + newline + descriptions.join(newline) + newline + newline
		const position = laterCategoryIndex(result, category)
		result =
			position === undefined
				? result.trimEnd() + newline + newline + block
				: result.slice(0, position) + block + result.slice(position)
	}

	return result
}

function categoryHeading(body: string, category: Category): RegExpExecArray | undefined {
	return new RegExp(String.raw`^### ${category}\s*$`, 'mv').exec(body) ?? undefined
}

/** Find where a new category goes to keep the canonical category order. */
function laterCategoryIndex(body: string, category: Category): number | undefined {
	const indexes = categories
		.slice(categories.indexOf(category) + 1)
		.map((item) => categoryHeading(body, item)?.index)
		.filter((index) => index !== undefined)
	return indexes.length === 0 ? undefined : Math.min(...indexes)
}

/** Render a release heading with an optional comparison link. */
function releaseLink(github: string | undefined, release: Release): string | undefined {
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
	const header = addNodeNote(parsed.header, newline, nodeException)

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

			body = newline + noNotableChanges + newline
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

		if (link === undefined) {
			continue
		}

		const definition = `[${release.version}]: ${link}`
		if (release.version === 'Unreleased') {
			footer = footer.replace(UNRELEASED_REFERENCE, '')
			definitions.unshift(definition)
		} else if (
			!new RegExp(String.raw`^\[${RegExp.escape(release.version)}\]:`, 'imv').test(footer)
		) {
			definitions.push(definition)
		}
	}

	if (entries.length === 0 && header === parsed.header) {
		return content
	}

	// A promoted draft leaves its comparison link without a heading to use it.
	if (draftText === '') {
		footer = footer.replace(UNRELEASED_REFERENCE, '')
	}

	const generated =
		sectionSpacing(sectionSpacing(header, newline) + draftText, newline) +
		additions.toReversed().join('')
	const preserved = released.join('') + footer
	const result = preserved === '' ? generated.trimEnd() + newline : generated + preserved
	return appendDefinitions(result, footer, definitions, newline)
}

/** Add link reference definitions after any existing footer. */
function appendDefinitions(
	content: string,
	footer: string,
	definitions: string[],
	newline: string,
): string {
	if (definitions.length === 0) {
		return content
	}

	const separated =
		footer === ''
			? sectionSpacing(content, newline)
			: content.endsWith(newline)
				? content
				: content + newline
	return separated + definitions.join(newline) + newline
}

function addNodeNote(header: string, newline: string, nodeException: boolean): string {
	if (nodeException && !header.includes(nodeExceptionNote)) {
		const semverLine = SEMVER_LINE.exec(header)
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

	return header
}

/**
 * Read a heading's version the way default tag patterns read a tag, so `1.2`
 * and `v1` name the first release of their series and a bare `1` names none.
 */
function normalizeVersion(raw: string): string {
	if (raw.toLowerCase() === 'unreleased') {
		return 'Unreleased'
	}

	const prefixed = V_PREFIX.test(raw)
	const parsed = parseVersion(prefixed ? raw.slice(1) : raw)
	return parsed === undefined || (!prefixed && parsed.precision === 1) ? raw : parsed.version
}

function releaseHeadingVersion(line: string): string | undefined {
	const match = RELEASE_HEADING.exec(line.trimEnd())
	if (match === null) {
		return undefined
	}

	const version = normalizeVersion(match[2] ?? match[3]!)
	if (semver.valid(version) !== null) {
		return version
	}

	// Conventional Changelog uses level-one and, in standard-version, level-three release
	// headings, but "# Changelog" is a title and "### Added" is a category.
	return match[1] === '##' || (version === 'Unreleased' && match[1] === '#') ? version : undefined
}

function sectionSpacing(content: string, newline: string): string {
	if (content.endsWith(newline + newline)) {
		return content
	}

	return content + (content.endsWith(newline) ? newline : newline + newline)
}
