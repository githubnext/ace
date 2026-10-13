type DocumentCandidate = {
	uid: string;
	name: string;
	aliases?: readonly string[];
};

const DOCUMENT_LITERAL = "\uE000";
const DOCUMENT_LITERAL_DOT = "\uE001";
const PLAN_LITERAL_DOT = "\uE002";
const PLAN_NAME = "plan.md";
const DOCUMENT_NAME = "[a-z0-9]+(?:-[a-z0-9]+)*\\.md";
const CODE_OR_ESCAPED_DOCUMENT = new RegExp(
	`\`\`\`[\\s\\S]*?(?:\`\`\`|$)|(\`+)[\\s\\S]*?\\1|(\\\\+)&(${DOCUMENT_NAME})`,
	"gi",
);

function protectDocumentReferences(text: string): string {
	return text.replace(
		CODE_OR_ESCAPED_DOCUMENT,
		(match, _ticks: string, slashes: string, name: string) => {
			if (!name || slashes.length % 2 === 0) return match;
			let encoded = name.replace(/\.md$/i, `${DOCUMENT_LITERAL_DOT}md`);
			return slashes.slice(0, -1) + DOCUMENT_LITERAL + encoded;
		},
	);
}

function restoreDocumentReferences(text: string): string {
	return text.replace(
		new RegExp(`${DOCUMENT_LITERAL}([a-z0-9]+(?:-[a-z0-9]+)*)${DOCUMENT_LITERAL_DOT}md`, "gi"),
		"&$1.md",
	);
}

function resolveDocument(
	documents: readonly DocumentCandidate[] | undefined,
	name: string,
): DocumentCandidate | undefined {
	let key = name.toLowerCase();
	return documents?.find(document =>
		document.name.toLowerCase() === key
		|| document.aliases?.some(alias => alias.toLowerCase() === key)
	);
}

function isPlan(name: string): boolean {
	return name.toLowerCase() === PLAN_NAME;
}

function isPlanHref(href: string): boolean {
	let value = href.toLowerCase();
	return value === "http://plan.md" || value === "http://plan.md/";
}

function isPlanBoundary(value: string): boolean {
	if (!value || /^[\s)\]},!,;'"]/.test(value)) return true;
	return /^[.?:](?:$|[\s)\]},!,;'"])/.test(value);
}

export {
	DOCUMENT_LITERAL,
	DOCUMENT_LITERAL_DOT,
	type DocumentCandidate,
	isPlan,
	isPlanBoundary,
	isPlanHref,
	PLAN_LITERAL_DOT,
	PLAN_NAME,
	protectDocumentReferences,
	resolveDocument,
	restoreDocumentReferences,
};
