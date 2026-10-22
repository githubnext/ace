/**
 * Demo mode: scripted synthetic teammates for recordings. They are present and act through the
 * same paths real teammates do. Their messages, asks and reactions are ordinary channel requests
 * that the channel admits by its own rules. Only their identities are made up, and only on this
 * host: presence and people go to the owner's own app, never to the directory, lobbies or peers.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Presence } from "@ace/directory/protocol";

import type { Event } from "@ace/channel/protocol";

import * as catalog from "./catalog";
import { Connection, request } from "./client";
import { failure, log } from "./log";
import type { People } from "./protocol";

type Person = {
	/** The participant name their messages carry, like a Tailscale login. */
	login: string;
	/** Whose GitHub avatar and name the app shows for them. */
	github: string;
};

type Target = { channel: string; chat?: number };

/** `at` is seconds from the script's start; each step does one thing. */
type Step =
	& { at: number; who: string }
	& (
		| ({ open: true } & Target)
		| ({ close: true } & Target)
		| { away: boolean }
		| { leave: true }
		/** Shows as typing in the chat for this many seconds. */
		| ({ type: number } & Target)
		| ({ say: string } & Target)
		| ({ ask: string } & Target)
		/** Reacts to the chat's newest message or reply. */
		| ({ react: string } & Target)
	);

export type Script = {
	people: Record<string, Person>;
	steps: Step[];
	/** Seconds after the last step before the script starts over; once when absent. */
	loop?: number;
};

type Here = { channels: Set<string>; away: boolean };

let script: Script | undefined;
const here = new Map<string, Here>();
let project: (channel: string) => Promise<string>;
let changed: () => void;
/** Each listed channel's project, kept from each step so presence can be read synchronously. */
const projects = new Map<string, string>();
let timers: ReturnType<typeof setTimeout>[] = [];

export function people(): People {
	const found: People = {};
	for (const person of Object.values(script?.people || {})) found[person.login] = person.github;
	return found;
}

/** Synthetic people's presence by project, in the lobby's shape. */
export function presence(): Record<string, Presence[]> {
	const found: Record<string, Presence[]> = {};
	for (const [who, state] of here) {
		const person = script!.people[who]!;
		const byProject = new Map<string, string[]>();
		for (const channel of state.channels) {
			const id = projects.get(channel);
			if (!id) continue;
			byProject.set(id, [...byProject.get(id) || [], channel]);
		}
		for (const [id, channels] of byProject) {
			(found[id] ||= []).push({ login: person.github, host: "demo", channels, away: state.away });
		}
	}
	return found;
}

function channelId(name: string): string {
	const record = catalog.list().find((value) => value.name === name || value.id === name);
	if (!record) throw new Error(`No channel ${name} on this host`);
	return record.id;
}

async function present(who: string, target: Target) {
	const id = channelId(target.channel);
	projects.set(id, await project(id));
	let state = here.get(who);
	if (!state) here.set(who, state = { channels: new Set(), away: false });
	state.channels.add(id);
	state.away = false;
	changed();
	return id;
}

/** The chat's newest message or reply, read from the replayed transcript. */
async function newest(id: string, chat?: number): Promise<number> {
	const connection = await Connection.open(id);
	try {
		let entry: number | undefined;
		const live = Promise.withResolvers<void>();
		await connection.request({ op: "watch", ...(chat === undefined ? {} : { chat }) }, {
			event(event: Event) {
				if (event.kind === "message" || event.kind === "reply") entry = event.entry;
				if (event.kind === "live") live.resolve();
			},
			closed: (error) => live.reject(new Error(error)),
		});
		await live.promise;
		if (entry === undefined) throw new Error(`Nothing to react to in ${id}`);
		return entry;
	} finally {
		connection.close();
	}
}

async function run(step: Step) {
	const person = script!.people[step.who];
	if (!person) throw new Error(`No person ${step.who} in the script`);
	const author = person.login;
	if ("leave" in step) {
		here.delete(step.who);
		return changed();
	}
	if ("away" in step) {
		const state = here.get(step.who);
		if (state) state.away = step.away;
		return changed();
	}
	if ("close" in step) {
		here.get(step.who)?.channels.delete(channelId(step.channel));
		return changed();
	}
	const id = await present(step.who, step);
	const chat = step.chat === undefined ? {} : { chat: step.chat };
	if ("type" in step) {
		// The app drops a typist 5 s after their last signal.
		for (let left = step.type; left > 0; left -= 3) {
			await request(id, { op: "typing", author, ...chat });
			await Bun.sleep(Math.min(left, 3) * 1000);
		}
		return;
	}
	if ("say" in step) return void await request(id, { op: "say", author, text: step.say, ...chat });
	// An ask returns once admitted; the run continues in the channel as anyone's would.
	if ("ask" in step) return void await request(id, { op: "ask", author, text: step.ask, ...chat });
	if ("react" in step) {
		const entry = await newest(id, step.chat);
		await request(id, { op: "react", author, entry, emoji: step.react, ...chat });
	}
}

function schedule() {
	const steps = [...script!.steps].sort((a, b) => a.at - b.at);
	let last = 0;
	for (const step of steps) {
		last = Math.max(last, step.at);
		timers.push(setTimeout(() => {
			log("info", "demo.step", { who: step.who, at: step.at });
			run(step).catch((error) =>
				log("warn", "demo.step.failed", { at: step.at, ...failure(error) })
			);
		}, step.at * 1000));
	}
	if (script!.loop === undefined) return;
	timers.push(setTimeout(() => {
		timers = [];
		here.clear();
		changed();
		schedule();
	}, (last + script!.loop) * 1000));
}

const ACTIONS = ["open", "close", "away", "leave", "type", "say", "ask", "react"];
const UNTARGETED = new Set(["away", "leave"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The script in `file`, or an error naming what's wrong in one line, before the host serves. */
export function read(file: string): Script {
	const path = resolve(file);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		throw new Error(`No demo script at ${path}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`${file} is not JSON: ${(error as Error).message}`, { cause: error });
	}
	const fail = (problem: string) => new Error(`${file}: ${problem}. See docs/demo.md.`);
	if (!isObject(value) || !isObject(value.people)) {
		throw fail(`needs "people", naming each person's "login" and "github"`);
	}
	for (const [who, person] of Object.entries(value.people)) {
		if (
			!isObject(person) || typeof person.login !== "string" || typeof person.github !== "string"
		) {
			throw fail(`person ${who} needs a "login" and a "github" login`);
		}
	}
	if (!Array.isArray(value.steps)) throw fail(`needs "steps", a list`);
	for (const [index, step] of value.steps.entries()) {
		const where = `step ${index + 1}`;
		if (!isObject(step)) throw fail(`${where} is not an object`);
		if (typeof step.at !== "number" || step.at < 0) {
			throw fail(`${where} needs "at", seconds from the start`);
		}
		if (typeof step.who !== "string" || !(step.who in value.people)) {
			throw fail(
				`${where} needs "who", one of ${Object.keys(value.people).join(", ") || "the people"}`,
			);
		}
		const actions = ACTIONS.filter((action) => action in step);
		if (actions.length !== 1) throw fail(`${where} needs exactly one of ${ACTIONS.join(", ")}`);
		if (!UNTARGETED.has(actions[0]!) && typeof step.channel !== "string") {
			throw fail(`${where} needs "channel"`);
		}
	}
	if (value.loop !== undefined && typeof value.loop !== "number") throw fail(`"loop" is seconds`);
	return value as Script;
}

/** Starts a script read from `file`; the returned function stops it and takes everyone away. */
export function start(
	value: Script,
	file: string,
	options: { project(channel: string): Promise<string>; changed(): void },
): () => void {
	script = value;
	({ project, changed } = options);
	log("info", "demo.start", { file, people: Object.keys(script.people).length });
	console.log(`Demo mode: ${Object.keys(script.people).join(", ")} from ${file}`);
	changed();
	schedule();
	return () => {
		for (const timer of timers) clearTimeout(timer);
		timers = [];
		here.clear();
		script = undefined;
	};
}
