import type { Tool } from "../../types";
import { languages, patchFile } from "../../lib/highlighter";
import { SMALL_LINE_HEIGHT } from "./constants";
import { diff as diffBlock } from "./diff";
import { fonts as blockFonts } from "./parse";

const ROW_HEIGHT = 26;
const BORDER = 1;
const RESULT_PAD_X = 16;
const RESULT_PAD_Y = 10;
const RESULT_MAX_HEIGHT = 320;
const AGENT_PREVIEW_MAX_LINES = 8;
const toolTextFonts = blockFonts();
const TOOL_TEXT_FONT = { font: toolTextFonts.font, lineHeight: `${toolTextFonts.lineHeight}px` };

type Status = Tool["status"] | "running";

type ToolData = {
	id: string;
	name: string;
	status: Status;
	agent?: Tool["agent"];
	args?: string;
	result?: string;
	images?: string[];
};
/** Tool names whose result is a verbatim file body and should be highlighted
 *  by the file's extension. Normalized via `normalize()` so PascalCase,
 *  snake_case, and kebab-case spellings all collapse to the same key. */
const READ = new Set([
	"cat",
	"notebookread",
	"open",
	"read",
	"readfile",
	"view",
	"viewfile",
	"viewrange",
]);

function normalize(name: string) {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resultFrame(
	data: ToolData,
	expanded: boolean,
	resultExpanded: boolean,
	width: number,
) {
	if (!expanded) return { clipped: false, height: 0 };

	let preview = agentPreview(data);
	if (preview) {
		let lines = preview.split("\n").length;
		return { clipped: false, height: lines * toolTextFonts.lineHeight + RESULT_PAD_Y * 2 + BORDER };
	}

	if (!data.result) return { clipped: false, height: 0 };
	let file = patchFile(data.result);
	if (file) {
		let diff = diffBlock(data.result, false, file);
		return { clipped: false, diff, height: diff.measure(width).height };
	}

	let lines = data.result.split("\n").length;
	let full = lines * SMALL_LINE_HEIGHT + RESULT_PAD_Y * 2 + BORDER;
	let clipped = isRead(data.name) && full > RESULT_MAX_HEIGHT && !resultExpanded;
	return { clipped, height: clipped ? RESULT_MAX_HEIGHT : full };
}

function loadingStatus(status: Status) {
	return status === "pending" || status === "start" || status === "running";
}

function titleFor(data: ToolData): string {
	if (isSubagent(data)) {
		let name = data.agent?.display ?? data.agent?.name ?? data.args ?? "sub-agent";
		return `Sub-agent: ${name}`;
	}

	if (!data.args) return data.name;
	let name = normalize(data.name);
	if (READ.has(name)) return `${data.name} ${basename(data.args)}`;
	return `${data.name} ${data.args}`;
}

function basename(path: string): string {
	let clean = path.replaceAll("\\", "/");
	return clean.slice(clean.lastIndexOf("/") + 1) || path;
}

function language(data: ToolData) {
	if (/^---\s|\ndiff --git\s|\n@@\s/.test(data.result || "")) return "diff";
	if (!isRead(data.name)) return undefined;
	let ext = data.args?.match(/\.([a-z0-9]+)(?=$|[\s"'`):])/i)?.[1]?.toLowerCase();
	return ext ? languages.get(ext) : undefined;
}

function isRead(name: string) {
	return READ.has(normalize(name));
}

function isSubagent(data: ToolData) {
	return data.agent?.kind === "subagent" || normalize(data.name) === "task";
}

function agentPreview(data: ToolData) {
	let text = data.agent?.error || data.agent?.preview;
	if (!text?.trim()) return undefined;

	let lines = text.trimEnd().split("\n");
	if (lines.length <= AGENT_PREVIEW_MAX_LINES) return lines.join("\n");
	return ["…", ...lines.slice(-AGENT_PREVIEW_MAX_LINES)].join("\n");
}

export {
	agentPreview,
	isSubagent,
	language,
	loadingStatus,
	RESULT_PAD_X,
	RESULT_PAD_Y,
	resultFrame,
	ROW_HEIGHT,
	titleFor,
	TOOL_TEXT_FONT,
	type ToolData,
};
