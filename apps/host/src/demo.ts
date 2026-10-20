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

/** Starts the script in `file`; the returned function stops it and takes everyone away. */
export function start(
	file: string,
	options: { project(channel: string): Promise<string>; changed(): void },
): () => void {
	script = JSON.parse(readFileSync(resolve(file), "utf8")) as Script;
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
