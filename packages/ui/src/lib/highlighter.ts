import {
	codeToHtml,
	createCSSVariablesTheme,
	type FileContents,
	type FileDiffMetadata,
	type FileDiffOptions,
	type FileOptions,
	getSingularPatch,
	parseDiffFromFile,
	registerCustomTheme,
} from "@pierre/diffs";
import { preloadDiffHTML, preloadFile } from "@pierre/diffs/ssr";
import { bundledLanguagesInfo } from "shiki";

/** Shared Shiki theme. Token colors resolve to `--syntax-*` CSS variables
 *  declared in `src/styles/syntax.css`, so light/dark switch with `.dark`. */
const theme = createCSSVariablesTheme({
	name: "ace",
	variablePrefix: "--syntax-",
	variableDefaults: {},
	fontStyle: true,
});

registerCustomTheme("ace", () => Promise.resolve(theme));

/** Maps every Shiki language id and alias to its canonical id. Built once
 *  from `bundledLanguagesInfo` so new Shiki languages are picked up
 *  automatically without touching this file. */
const languages = new Map<string, string>();
for (let info of bundledLanguagesInfo) {
	languages.set(info.id, info.id);
	for (let alias of info.aliases || []) languages.set(alias, info.id);
}

const LIMIT = 512;

type Entry = {
	promise: Promise<string>;
	html?: string;
};

let cache = new Map<string, Entry>();

const options = {
	diffStyle: "unified",
	disableFileHeader: true,
	hunkSeparators: "line-info",
	diffIndicators: "classic",
	expansionLineCount: 40,
	theme: "ace",
	unsafeCSS: `
		[data-diff] {
			--diffs-grid-number-column-width: calc(3ch + 24px);
			--diffs-bg-separator-override: var(--color-background);
		}

		[data-gutter] [data-column-number] {
			padding-inline: 0.5rem;
			padding-inline-start: 1rem;
		}

		[data-gutter] [data-column-number][data-line-type='context'] {
			color: color-mix(in oklch, var(--color-muted-foreground), transparent 25%);
		}

		[data-code] {
			padding-block: 6px 0;
		}

		[data-diff-type='split'][data-overflow='scroll'] > [data-code] {
			min-width: 0;
		}

		[data-diff-type='split'] > [data-code][data-additions] {
			margin-inline-start: -1px;
		}

		[data-diff-type='split'] [data-content] {
			margin-inline-start: -1px;
		}

		[data-content] :is(
			[data-line-type='change-addition'],
			[data-line-type='change-deletion']
		) {
			padding-inline-start: calc(1.2em + 4px);
		}

		[data-content] :is(
			[data-line-type='change-addition'],
			[data-line-type='change-deletion']
		)::before {
			inset-inline-start: 4px;
		}

		[data-separator='line-info'] {
			background-color: var(--diffs-bg-separator);
			color: var(--color-muted-foreground);
		}

		[data-separator='line-info'] [data-separator-content],
		[data-separator='line-info'] [data-expand-button] {
			background-color: var(--diffs-bg-separator);
			color: var(--color-muted-foreground);
		}

		[data-separator='line-info'] [data-separator-content] {
			padding-inline: 0.65rem;
		}

		[data-separator='line-info']:has([data-expand-button]) {
			background-color: transparent;
		}

		[data-separator='line-info']:has([data-expand-button]) [data-separator-wrapper] {
			cursor: pointer;
			margin-inline: 0;
			overflow: hidden;
			border-radius: 4px;
		}

		[data-separator='line-info']:has([data-expand-button]) [data-separator-content] {
			padding-inline: 0;
			transition:
				color 150ms ease-out;
		}

		[data-separator='line-info']:has([data-expand-button]) [data-unmodified-lines] {
			box-sizing: border-box;
			inline-size: 100%;
			block-size: 100%;
			padding-inline-start: 16px;
			align-content: center;
		}

		[data-separator='line-info']:has([data-expand-button]) [data-expand-button] svg {
			transition:
				transform 150ms ease-out;
		}

		[data-separator='line-info']:has([data-expand-button]) [data-separator-content]:hover,
		[data-separator='line-info']:has([data-expand-button]) [data-unmodified-lines] {
			text-decoration-line: none;
		}

		[data-separator='line-info']:has([data-expand-button]):hover {
			background-color: transparent;
		}

		[data-separator='line-info']:has([data-expand-button]):hover [data-separator-content],
		[data-separator='line-info']:has([data-expand-button]):hover [data-expand-button] {
			background-color: var(--color-muted);
			color: var(--color-muted-foreground);
		}

		[data-separator='line-info']:has([data-expand-button]) [data-expand-button]:active svg {
			transform: translateY(1px) scale(0.96);
		}

		[data-diff-type='split'] [data-deletions] [data-content] [data-separator='line-info']:has([data-expand-button]) [data-separator-wrapper] {
			display: flex;
			height: 100%;
			margin-inline: 0;
			border-radius: 0;
			background-color: var(--diffs-bg-separator);
		}

		[data-diff-type='split'] [data-deletions] [data-content] [data-separator='line-info']:has([data-expand-button]) [data-expand-button] {
			display: none;
		}

		[data-diff-type='split'] [data-deletions] [data-content] [data-separator='line-info']:has([data-expand-button]) [data-separator-content] {
			min-width: 0;
			padding-inline-start: 0.65rem;
			border-radius: 0;
		}

	`,
} satisfies FileDiffOptions<undefined>;

const source = {
	disableFileHeader: true,
	overflow: "scroll",
	theme: "ace",
	unsafeCSS: `
		[data-file] {
			--diffs-grid-number-column-width: minmax(min-content, max-content);
		}

		[data-file] [data-code],
		[data-file] [data-content],
		[data-file] [data-line] {
			-webkit-user-select: text;
			user-select: text;
		}
	`,
} satisfies FileOptions<undefined>;

type DiffStyle = NonNullable<FileDiffOptions<undefined>["diffStyle"]>;
type DiffOptionsOverride = Partial<Pick<FileDiffOptions<undefined>, "hunkSeparators">>;

function diffOptions(
	style: DiffStyle = "unified",
	overrides?: DiffOptionsOverride,
): FileDiffOptions<undefined> {
	return { ...options, ...overrides, diffStyle: style };
}

function lang(value: string | undefined) {
	return (value && languages.get(value)) || "text";
}

function key(language: string | undefined, source: string) {
	return lang(language) + "\0" + source;
}

type DiffContents = {
	oldFile?: FileContents;
	newFile?: FileContents;
};

function hash(value: string) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

function contentKey(contents?: DiffContents) {
	if (!contents?.oldFile || !contents.newFile) return "";
	return [
		contents.oldFile.name,
		contents.oldFile.contents.length,
		hash(contents.oldFile.contents),
		contents.newFile.name,
		contents.newFile.contents.length,
		hash(contents.newFile.contents),
	].join("\0");
}

function fileKey(file: FileContents) {
	return `file:${
		file.cacheKey ?? [
			file.name,
			file.lang ?? "",
			file.contents.length,
			hash(file.contents),
		].join("\0")
	}`;
}

function diffKey(
	style: DiffStyle,
	patch: string,
	file?: FileDiffMetadata | null,
	overrides?: DiffOptionsOverride,
) {
	return `file-diff:${style}:${overrides?.hunkSeparators ?? options.hunkSeparators}\0${
		file?.cacheKey ?? patch
	}`;
}

function get(key: string) {
	let hit = cache.get(key);
	if (!hit) return;
	cache.delete(key);
	cache.set(key, hit);
	return hit;
}

function set(key: string, entry: Entry) {
	if (cache.has(key)) cache.delete(key);
	while (cache.size >= LIMIT) cache.delete(cache.keys().next().value!);
	cache.set(key, entry);
}

function render(key: string, fn: () => string | Promise<string>) {
	let hit = get(key);
	if (hit) return hit;

	let entry = {} as Entry;
	entry.promise = Promise.resolve(fn()).then(
		html => {
			entry.html = html;
			return html;
		},
		error => {
			if (cache.get(key) === entry) cache.delete(key);
			throw error;
		},
	);
	set(key, entry);
	return entry;
}

function cached(source: string, language?: string) {
	return get(key(language, source))?.html;
}

/** Render `source` as highlighted HTML. Unknown languages fall back to `text`. */
function highlight(source: string, language?: string) {
	return render(
		key(language, source),
		() => codeToHtml(source, { lang: lang(language), theme }),
	)
		.promise;
}

function cachedDiff(
	patch: string,
	style: DiffStyle = "unified",
	file?: FileDiffMetadata | null,
	overrides?: DiffOptionsOverride,
) {
	return get(diffKey(style, patch, file, overrides))?.html;
}

function cachedFile(file: FileContents) {
	return get(fileKey(file))?.html;
}

function complete(patch: string) {
	return (
		/^diff --git\s+\S+\s+\S+/m.test(patch)
		|| (
			/^---\s+\S+/m.test(patch)
			&& /^\+\+\+\s+\S+/m.test(patch)
			&& /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?/m.test(patch)
		)
	);
}

function parseDiff(patch: string, contents?: DiffContents): FileDiffMetadata | null {
	if (!complete(patch)) return null;
	try {
		if (contents?.oldFile && contents.newFile) {
			let key = contentKey(contents);
			return parseDiffFromFile(
				{ ...contents.oldFile, cacheKey: `${key}:old` },
				{ ...contents.newFile, cacheKey: `${key}:new` },
			);
		}
		return getSingularPatch(patch);
	} catch {
		try {
			return getSingularPatch(patch);
		} catch {
			return null;
		}
	}
}

function highlightDiff(
	patch: string,
	file = parseDiff(patch),
	style: DiffStyle = "unified",
	overrides?: DiffOptionsOverride,
) {
	if (!file) return Promise.resolve("");
	return render(
		diffKey(style, patch, file, overrides),
		() => preloadDiffHTML({ fileDiff: file, options: diffOptions(style, overrides) }),
	).promise;
}

function fileOptions(): FileOptions<undefined> {
	return source;
}

function highlightFile(file: FileContents) {
	return render(
		fileKey(file),
		() => preloadFile({ file, options: fileOptions() }).then(result => result.prerenderedHTML),
	).promise;
}

export {
	cached,
	cachedDiff,
	cachedFile,
	diffOptions,
	fileOptions,
	highlight,
	highlightDiff,
	highlightFile,
	languages,
	LIMIT,
	parseDiff,
	theme,
};
export type { DiffContents, DiffOptionsOverride, DiffStyle };
