import * as Split from "@ace/split-tabs";

import { load, remove, save } from "../window-storage";

/** The Chat tab's uid; it can't be closed or renamed. */
export const CHAT = "chat";

const STORAGE = "ace:channel-layout";
const VERSION = 1;
const KINDS = new Set<Kind>(["blank", "chat", "diff", "terminal"]);

/** Diff and Terminal tabs belong to the chat whose lane they show. */
export type Content =
	& (
		| { type: "blank" }
		| { type: "chat" }
		| { type: "diff"; chat: number }
		| { type: "terminal"; chat: number; terminal?: string }
	)
	& { name?: string };

export type Kind = Content["type"];
export type Meta = Record<string, Content>;

/** `diff` records that a Diff tab already opened for the chat's current changes. */
type Layout = { state: Split.State; meta: Meta; diff: boolean };

type Saved = { version: typeof VERSION; state: Split.Data; tabs: Meta; diff?: boolean };

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function content(kind: Kind, chat: number): Content {
	if (kind === "diff" || kind === "terminal") return { type: kind, chat };
	return { type: kind };
}

export function fallback(uid: string): Content {
	return uid === CHAT ? { type: "chat" } : { type: "blank" };
}

function clean(state: Split.State, meta?: unknown): Meta {
	const input = object(meta) ? meta : {};
	const next: Meta = {};
	for (const uid of state.tabs) {
		const value = input[uid];
		if (uid === CHAT || !object(value) || !KINDS.has(value.type as Kind)) {
			next[uid] = fallback(uid);
			continue;
		}
		const chat = Number.isInteger(value.chat) && (value.chat as number) > 0
			? value.chat as number
			: 1;
		const name = typeof value.name === "string" ? value.name.trim() : "";
		const terminal = value.type === "terminal" && typeof value.terminal === "string"
			? value.terminal
			: undefined;
		next[uid] = {
			...content(value.type as Kind, chat),
			...(name ? { name } : undefined),
			...(terminal ? { terminal } : undefined),
		};
	}
	return next;
}

export function read(id: string): Layout {
	const raw = load(`${STORAGE}:${id}`);
	if (raw) {
		try {
			const data = JSON.parse(raw) as Saved;
			const state = Split.restore(data.state);
			return { state, meta: clean(state, data.tabs), diff: data.diff === true };
		} catch {
			remove(`${STORAGE}:${id}`);
		}
	}
	const state = Split.initial(CHAT);
	return { state, meta: clean(state), diff: false };
}

export function write(id: string, state: Split.State, meta: Meta, diff: boolean) {
	const data = {
		version: VERSION,
		state: Split.save(state),
		tabs: clean(state, meta),
		diff,
	} satisfies Saved;
	save(`${STORAGE}:${id}`, JSON.stringify(data));
}
