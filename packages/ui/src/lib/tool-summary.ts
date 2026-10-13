import type { Tool } from "../types";

type Status = Tool["status"];

type ToolKind = "explore" | "search" | "list" | "run" | "edit" | "subagent" | "agent" | "tool";

/** A tool in structured output. */
type ToolNode = {
	id: string;
	name: string;
	status: Status;
	agent?: Tool["agent"];
	caption?: string;
	recap?: string;
	args?: string;
	input?: Record<string, unknown>;
	result?: string;
	images?: string[];
	children?: ToolNode[];
};

type ToolGroup = {
	id: string;
	uid: string;
	summary: string;
	/** The newest caption among the group's tools. */
	caption?: string;
	tools: ToolNode[];
};

/** Tools that modify existing files. */
const EDIT_TOOLS = new Set([
	"str_replace_editor",
	"edit",
	"edit_file",
	"apply_diff",
	"apply_patch",
	"full_file_rewrite",
]);

/** Tools that create new files. */
const CREATE_TOOLS = new Set(["create", "create_file", "write", "write_to_file", "write_file"]);

const EDIT_KEYS = new Set([
	...EDIT_TOOLS,
	...CREATE_TOOLS,
	"editFile",
	"writeFile",
	"createFile",
	"strReplaceEditor",
	"fullFileRewrite",
	"writeToFile",
	"applyDiff",
	"applyPatch",
].map(compact));
const CREATE_KEYS = new Set([
	...CREATE_TOOLS,
	"createFile",
	"writeFile",
	"writeToFile",
].map(compact));
const READ_KEYS = new Set(
	["cat", "open", "read", "readFile", "view", "viewFile", "viewRange", "NotebookRead"].map(compact),
);
const SEARCH_KEYS = new Set(["grep", "rg", "ripgrep", "search"].map(compact));
const LIST_KEYS = new Set(["find", "findFiles", "glob", "list", "listFiles", "ls"].map(compact));
const RUN_KEYS = new Set([
	"bash",
	"powershell",
	"local_shell",
	"read_bash",
	"write_bash",
	"stop_bash",
	"list_bash",
	"read_powershell",
	"write_powershell",
	"stop_powershell",
	"list_powershell",
	"exec",
	"execute",
	"run",
	"shell",
	"terminal",
].map(compact));
const SUBAGENT_KEYS = new Set(["task", "subagent"].map(compact));
const AGENT_KEYS = new Set(
	["agent", "agents", "readAgent", "writeAgent", "listAgents"].map(compact),
);

const SUMMARY_FIELDS = [
	"path",
	"file",
	"command",
	"query",
	"pattern",
	"comment",
	"body",
	"url",
	"question",
	"title",
	"message",
	"name",
	"toolName",
	"serverName",
	"action",
	"operation",
	"intent",
	"prompt",
	"description",
	"shellId",
	"database",
	"sql",
	"summary",
] as const;

/** Convert a Tool tree into a ToolNode tree. */
function toToolNode(t: Tool): ToolNode {
	let node: ToolNode = { id: t.id, name: t.name, status: t.status };
	if (t.agent) node.agent = t.agent;
	if (t.caption) node.caption = t.caption;
	if (t.recap) node.recap = t.recap;
	node.input = t.arguments;
	let args = summarizeArgs(t.arguments);
	if (args) node.args = args;
	if (t.result?.content) node.result = t.result.content;
	if (t.result?.images?.length) node.images = t.result.images;
	if (t.children?.length) node.children = t.children.map(toToolNode);
	return node;
}

function summarizeTools(tools: readonly ToolNode[]): string {
	let counts = countTools(tools);
	let parts: string[] = [];
	let discovery: string[] = [];

	if (counts.explore) discovery.push(plural(counts.explore, "file"));
	if (counts.search) discovery.push(plural(counts.search, "search", "searches"));
	if (counts.list) discovery.push(plural(counts.list, "list"));

	if (counts.edit) parts.push(`Edited ${plural(counts.edit, "file")}`);
	if (discovery.length) parts.push(`Explored ${discovery.join(", ")}`);
	if (counts.run) parts.push(`Ran ${plural(counts.run, "command")}`);
	if (counts.subagent) parts.push(`Used ${plural(counts.subagent, "sub-agent")}`);
	if (counts.agent) parts.push(`Used ${plural(counts.agent, "agent tool")}`);
	if (counts.tool) parts.push(`Used ${plural(counts.tool, "tool")}`);

	return parts.join(", ") || "Used tools";
}

function summarizeWorkingTools(tools: readonly ToolNode[], start: number, end: number): string {
	let seconds = Math.max(0, Math.round(end - start));
	let minutes = Math.floor(seconds / 60);
	let remaining = seconds % 60;
	let duration = seconds === 0
		? "less than a second"
		: minutes === 0
		? plural(seconds, "second")
		: `${plural(minutes, "minute")}${remaining ? ` ${plural(remaining, "second")}` : ""}`;
	return `Worked for ${duration}, ran ${plural(tools.length, "tool call")}`;
}

function captionTools(tools: readonly ToolNode[]): string | undefined {
	return tools.findLast((tool) => tool.caption)?.caption;
}

function editsFile(tool: ToolNode): boolean {
	return kind(tool) === "edit";
}

function createsFile(tool: ToolNode): boolean {
	return CREATE_KEYS.has(compact(tool.name));
}

/** Extract a display string from tool arguments. */
function summarizeArgs(args: Record<string, unknown>): string | undefined {
	for (let key of SUMMARY_FIELDS) {
		let value = args[key];
		if (typeof value === "string" && value) return value;
		if (Array.isArray(value)) {
			let text = value.filter(v => typeof v === "string").join(", ");
			if (text) return text;
		}
	}
	return undefined;
}

function compact(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function kind(tool: ToolNode): ToolKind {
	let name = compact(tool.name);
	if (tool.agent?.kind === "subagent" || SUBAGENT_KEYS.has(name)) return "subagent";
	if (AGENT_KEYS.has(name)) return "agent";
	if (EDIT_KEYS.has(name)) return "edit";
	if (READ_KEYS.has(name)) return "explore";
	if (SEARCH_KEYS.has(name)) return "search";
	if (LIST_KEYS.has(name)) return "list";
	if (RUN_KEYS.has(name)) return "run";
	return "tool";
}

function countTools(tools: readonly ToolNode[]): Record<ToolKind, number> {
	let counts: Record<ToolKind, number> = {
		explore: 0,
		search: 0,
		list: 0,
		run: 0,
		edit: 0,
		subagent: 0,
		agent: 0,
		tool: 0,
	};
	let paths = {
		explore: new Set<string>(),
		edit: new Set<string>(),
	};

	for (let tool of tools) {
		let k = kind(tool);
		counts[k]++;
		if ((k === "explore" || k === "edit") && tool.args) paths[k].add(tool.args);
	}

	return {
		...counts,
		explore: paths.explore.size || counts.explore,
		edit: paths.edit.size || counts.edit,
	};
}

function plural(count: number, one: string, many = one + "s"): string {
	return `${count} ${count === 1 ? one : many}`;
}

export { captionTools, createsFile, editsFile, summarizeTools, summarizeWorkingTools, toToolNode };
export type { Status, ToolGroup, ToolKind, ToolNode };
