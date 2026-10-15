import type { Context } from "@earendil-works/chord";
import type { PromptSection } from "@earendil-works/pi-durable";
import type { ExecutionEnv, FileError } from "@earendil-works/pi-durable/env";

/** Instruction files at the checkout root, in the order agents conventionally read them. */
const INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"];
const SKILLS = [".agents/skills", ".claude/skills"];
const RULES = ".claude/rules";
const LIMIT = 32_000;

/**
 * Only a missing file means "none". Any other failure, such as an unreachable workspace, throws, so
 * pi keeps the instructions it last showed and reports why instead of dropping them.
 */
function absent(error: FileError): undefined {
	if (!["not_found", "not_directory", "is_directory"].includes(error.code)) throw error;
}

async function read(
	env: ExecutionEnv,
	path: string,
	context: Context,
): Promise<string | undefined> {
	const result = await env.readTextFile(`${env.cwd}/${path}`, context);
	if (!result.ok) return absent(result.error);
	const text = result.value.trim();
	return text.length > LIMIT
		? `${text.slice(0, LIMIT)}\n… (truncated; read ${path} for the rest)`
		: text;
}

async function list(env: ExecutionEnv, path: string, context: Context) {
	const result = await env.listDir(`${env.cwd}/${path}`, context);
	if (result.ok) return result.value;
	absent(result.error);
	return [];
}

/** The YAML front matter's flat `key: value` lines, which is all skills and rules use. */
function front(text: string): Record<string, string> {
	const match = /^---\n([\s\S]*?)\n---/.exec(text);
	if (!match) return {};
	const fields: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const split = line.indexOf(":");
		if (split > 0) {
			fields[line.slice(0, split).trim()] = line.slice(split + 1).trim().replace(/^"|"$/g, "");
		}
	}
	return fields;
}

async function skills(env: ExecutionEnv, context: Context): Promise<string[]> {
	const out: string[] = [];
	for (const dir of SKILLS) {
		for (const entry of await list(env, dir, context)) {
			if (entry.kind !== "directory") continue;
			const path = `${dir}/${entry.name}/SKILL.md`;
			const text = await read(env, path, context);
			if (!text) continue;
			const { name, description } = front(text);
			out.push(`- ${name || entry.name} (${path})${description ? `: ${description}` : ""}`);
		}
	}
	return out;
}

/** Rule files, nested one directory deep, with the paths each applies to. */
async function rules(env: ExecutionEnv, context: Context): Promise<string[]> {
	const out: string[] = [];
	const visit = async (dir: string, depth: number) => {
		for (const entry of await list(env, dir, context)) {
			const path = `${dir}/${entry.name}`;
			if (entry.kind === "directory" && depth > 0) await visit(path, depth - 1);
			if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
			const { paths } = front(await read(env, path, context) ?? "");
			out.push(`- ${path}${paths ? ` (applies to ${paths})` : ""}`);
		}
	};
	await visit(RULES, 1);
	return out.sort();
}

/**
 * The checkout's own instructions, read from the agent's working directory before each request so
 * a lane sees its own edits to them. Unchanged text is not resent, which keeps prompt caches warm.
 */
export const instructions: PromptSection = {
	key: "project-instructions",
	async render({ env }, context) {
		if (!env) return;
		const parts: string[] = [];
		const seen = new Set<string>();
		for (const file of INSTRUCTIONS) {
			const text = await read(env, file, context);
			// CLAUDE.md is often a pointer to AGENTS.md or a copy of it.
			if (!text || seen.has(text) || /^@AGENTS\.md$/.test(text)) continue;
			seen.add(text);
			parts.push(`<file path="${file}">\n${text}\n</file>`);
		}
		const found = await skills(env, context);
		if (found.length) {
			parts.push(
				`Skills in this repository. Read a skill's file before doing work it describes:\n${
					found.join("\n")
				}`,
			);
		}
		const applicable = await rules(env, context);
		if (applicable.length) {
			parts.push(
				`Rules in this repository. Read the ones that apply before editing matching files:\n${
					applicable.join("\n")
				}`,
			);
		}
		return parts.length ? parts.join("\n\n") : undefined;
	},
};
