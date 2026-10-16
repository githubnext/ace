import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { type Metadata, type ModelRef, type RunEnd, validateName } from "@ace/channel";

import { config } from "./config";
import { identity } from "./tailnet";

export type Listing = {
	version: 2;
	id: string;
	name: string;
	/** The original name remains the prefix for lane branches after a rename. */
	prefix: string;
	/** Whether the initial name was chosen deliberately rather than randomly. */
	named: boolean;
	/** A listing projection; pi's metadata document is authoritative once the channel opens. */
	summary?: string;
	revision?: number;
	owner: string;
	/**
	 * The tailnet the channel was created on, by MagicDNS suffix. Records from before tailnets were
	 * recorded have none; they stay on disk but no host lists them.
	 */
	tailnet?: string;
	project: string;
	model?: ModelRef;
	created: number;
	/** When the transcript last grew; channels from older builds have none until they next do. */
	active?: number;
	/** Rebuildable live-run projection, not history; valid only while its source is connected. */
	busy?: boolean;
	/** The latest invoked run's end, a hint for its author's attention; pi keeps the run itself. */
	ran?: RunEnd;
	archived?: boolean;
	/** Base URL of the service hosting the channel; this host serves its workspace unless `compute`. */
	hosted?: string;
	/** The hosting service is a cloud compute service, whose own container serves the workspace. */
	compute?: true;
	/**
	 * The compute workspace has no container: it was created stopped or stopped since. Only this
	 * host's own start and stop change it; records before #426 omit it even when stopped.
	 */
	stopped?: true;
	/**
	 * A move in progress fences the channel: no worker starts and no client connects until the
	 * move finishes or is resolved. `digest` names the snapshot an outbound move tried to activate.
	 */
	moving?: { to: string; digest?: string };
};

export const home = config.home;
const root = join(home, "channels");

/**
 * The local human, named by their Tailscale login so they are the same participant on every
 * host. Without Tailscale the host is single-user and the OS account name stands in.
 */
const current = identity();
export const user = config.user || current.login || userInfo().username;

/**
 * Channels belong to the tailnet they were created on, and a host shows only its own tailnet's.
 * Like `user`, it is fixed when the process starts; without Tailscale the host has no channels.
 */
export const tailnet = current.tailnet;

export function dir(id: string): string {
	return join(root, id);
}

export function paths(id: string) {
	const base = dir(id);
	return {
		base,
		record: join(base, "channel.json"),
		storage: join(base, "channel.sqlite"),
		socket: join(base, "channel.sock"),
		pid: join(base, "worker.pid"),
		lock: join(base, "worker.lock"),
		log: join(base, "worker.log"),
		lanes: join(base, "lanes"),
	};
}

const WORDS = [
	[
		"amber",
		"brisk",
		"calm",
		"deft",
		"eager",
		"fair",
		"glad",
		"hazy",
		"keen",
		"lucid",
		"mellow",
		"nimble",
	],
	[
		"anchor",
		"beacon",
		"cedar",
		"delta",
		"ember",
		"fjord",
		"grove",
		"harbor",
		"ladder",
		"meadow",
		"orbit",
		"ridge",
	],
];

function pick(words: string[]): string {
	return words[randomBytes(1)[0] % words.length];
}

/** A new channel's record, not yet saved: a hosted channel saves it once the service has it. */
export function draft(project: string, model?: ModelRef, name?: string, hosted?: string): Listing {
	if (!tailnet) throw new Error("Start Tailscale first: every channel belongs to a tailnet.");
	// Hidden channels keep their lane branches in the same projects, so names stay unique across all.
	const names = new Set(records().flatMap((record) => [record.name, record.prefix]));
	const random = () => `${pick(WORDS[0])}-${pick(WORDS[1])}`;
	let chosen = name ? validateName(name) : random();
	if (name && names.has(chosen)) throw new Error(`A channel named ${chosen} already exists`);
	while (names.has(chosen)) chosen = random();
	const record: Listing = {
		version: 2,
		id: randomBytes(8).toString("hex"),
		name: chosen,
		prefix: chosen,
		named: !!name,
		owner: user,
		tailnet,
		project,
		model,
		created: Date.now(),
		...(hosted ? { hosted } : {}),
	};
	return record;
}

export function create(project: string, model?: ModelRef, name?: string): Listing {
	return save(draft(project, model, name));
}

export function save(record: Listing): Listing {
	const { base, record: file } = paths(record.id);
	mkdirSync(base, { recursive: true });
	writeFileSync(file, JSON.stringify(record, null, "\t"));
	return record;
}

/** Whether this host runs the channel. Ids arrive from peers, so only well-formed ones reach the disk. */
export function owns(id: string): boolean {
	return /^[0-9a-f]{16}$/.test(id) && existsSync(paths(id).record) && isListed(read(id));
}

export function read(id: string): Listing {
	const record = JSON.parse(readFileSync(paths(id).record, "utf8")) as
		& Omit<Listing, "version" | "prefix" | "named">
		& Partial<Pick<Listing, "prefix" | "named">>
		& { version?: number };
	if (record.version !== undefined && record.version !== 1 && record.version !== 2) {
		throw new Error(
			`Channel ${id} uses catalog version ${record.version}. Open it with a compatible Ace build.`,
		);
	}
	if (record.version === 2) return record as Listing;
	// Older channels retain both their chosen name and their existing lane branch prefix.
	return { ...record, version: 2, prefix: record.name, named: true };
}

export function write(record: Listing): void {
	const path = paths(record.id).record;
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(record, null, "\t"));
	renameSync(temporary, path);
}

/** Rebuildable listing metadata from the channel's committed pi document. */
export function metadata(id: string, value: Metadata): void {
	const record = read(id);
	if (record.revision !== undefined && record.revision >= value.revision) return;
	write({ ...record, ...value });
}

export function activity(id: string, active: number): void {
	write({ ...read(id), active });
}

export function busy(id: string, busy: boolean): void {
	const record = read(id);
	if (record.busy === busy) return;
	write({ ...record, busy });
}

export function ran(id: string, ran: RunEnd): void {
	write({ ...read(id), ran });
}

function isListed(record: Listing): boolean {
	return !!tailnet && record.tailnet === tailnet;
}

function records(): Listing[] {
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((id) => existsSync(paths(id).record))
		.map(read);
}

/** This tailnet's channels; the others stay on disk untouched. */
export function list(): Listing[] {
	return records().filter(isListed).sort((a, b) => a.created - b.created);
}

/** Resolve a channel by ID or name. */
export function find(ref: string): Listing {
	const records = list();
	const identified = records.find((record) => record.id === ref);
	if (identified) return identified;
	const matches = records.filter((record) => record.name === ref);
	if (matches.length > 1) throw new Error(`More than one channel is named ${ref}; use its ID`);
	const record = matches[0];
	if (!record) throw new Error(`No channel ${ref}`);
	return record;
}

const held = new Map<string, Database>();

/**
 * One process owns a channel's storage: its worker, or a delete or move removing it. The owner
 * holds an exclusive SQLite lock, which the kernel releases when the owner exits or crashes, so no
 * contender ever reclaims a dead owner's claim by hand. The pid file only names the live owner.
 */
export function lock(id: string): boolean {
	const { lock, pid } = paths(id);
	const db = new Database(lock);
	try {
		db.run("BEGIN EXCLUSIVE");
	} catch (error) {
		db.close();
		if ((error as { code?: string }).code === "SQLITE_BUSY") return false;
		throw error;
	}
	held.set(id, db);
	const temporary = `${pid}.${process.pid}.tmp`;
	writeFileSync(temporary, String(process.pid));
	renameSync(temporary, pid);
	return true;
}

/** The pid file goes first: removed after the release, it could already be a new owner's. */
export function unlock(id: string): void {
	const db = held.get(id);
	if (!db) return;
	rmSync(paths(id).pid, { force: true });
	db.close();
	held.delete(id);
}

/** The caller holds the worker lock; a worker that takes it as the directory goes finds no record. */
export function remove(id: string): void {
	rmSync(paths(id).record, { force: true });
	rmSync(dir(id), { recursive: true, force: true, maxRetries: 5 });
	held.get(id)?.close();
	held.delete(id);
}
