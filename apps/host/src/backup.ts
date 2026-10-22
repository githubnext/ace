import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

import { importSnapshot, type Snapshot } from "@ace/channel/transfer";

import * as catalog from "./catalog";
import { hostedAuth, request } from "./client";
import { refusal } from "./http";
import { project } from "./manage";
import { offline } from "./seed";

async function checksum(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function snapshot(source: string, target: string): void {
	const database = new DatabaseSync(source, { readOnly: true, timeout: 5_000 });
	try {
		// INTO includes committed WAL data without changing or stopping the live channel.
		database.exec("PRAGMA synchronous = FULL");
		database.prepare("VACUUM INTO ?").run(target);
	} finally {
		database.close();
	}
	chmodSync(target, 0o600);
	const copy = new DatabaseSync(target, { readOnly: true });
	try {
		const rows = copy.prepare("PRAGMA quick_check").all();
		if (rows.length !== 1 || rows[0]!.quick_check !== "ok") {
			throw new Error("The channel backup failed SQLite's integrity check");
		}
	} finally {
		copy.close();
	}
}

/** The hosting service's consistent export of a hosted channel's pi state, taken without freezing it. */
async function exported(record: catalog.Listing): Promise<Snapshot> {
	const url = record.hosted!;
	let response: Response;
	try {
		response = await fetch(`${url}/channels/${record.id}/transfer`, {
			method: "POST",
			headers: { ...(await hostedAuth()), "content-type": "application/json" },
			body: JSON.stringify({ action: "backup" }),
		});
	} catch (error) {
		throw new Error(`Could not reach ${url}: ${(error as Error).message}.`, { cause: error });
	}
	if (response.ok) return await response.json() as Snapshot;
	if (response.status === 400 && (await response.clone().text()).includes("Unknown transfer")) {
		throw new Error(`${url} predates hosted channel backups; redeploy it to back this channel up.`);
	}
	throw new Error(await refusal(response, "The hosting service"));
}

function save(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
}

/** A channel storage snapshot; project files and lane worktrees need their own backup. */
export async function backup(record: catalog.Listing, directory: string): Promise<string> {
	// Read before creating the destination, so a refused or unreachable service leaves nothing behind.
	const hosted = record.hosted ? await exported(record) : undefined;
	const path = resolve(directory);
	// An existing destination must never be overwritten or removed by failed-backup cleanup.
	mkdirSync(path, { mode: 0o700 });
	try {
		const source = catalog.paths(record.id);
		save(join(path, "channel.json"), record);
		const names = ["channel.json"];
		if (hosted) {
			save(join(path, "snapshot.json"), hosted);
			names.push("snapshot.json");
		} else if (existsSync(source.storage)) {
			snapshot(source.storage, join(path, "channel.sqlite"));
			names.push("channel.sqlite");
		}
		const files = await Promise.all(names.map(async (file) => ({
			path: file,
			sha256: await checksum(join(path, file)),
		})));
		const manifest = {
			format: 1,
			created: new Date().toISOString(),
			channel: record.id,
			home: catalog.home,
			project: record.project,
			...(hosted ? { hosted: record.hosted, digest: hosted.digest } : { lanes: source.lanes }),
			files,
		};
		// Written last: a partial directory is never advertised as a completed backup.
		save(join(path, "backup.json"), manifest);
		return path;
	} catch (error) {
		rmSync(path, { recursive: true, force: true });
		throw error;
	}
}

/**
 * A backup as a new local channel. The new ID and lane prefix keep it from ever running as the
 * original, which may still be live here or on its hosting service.
 */
export async function restore(directory: string, dir?: string): Promise<catalog.Listing> {
	const path = resolve(directory);
	const manifest = JSON.parse(readFileSync(join(path, "backup.json"), "utf8")) as {
		format: number;
		files: { path: string; sha256: string }[];
	};
	if (manifest.format !== 1) throw new Error(`Unsupported backup format ${manifest.format}`);
	for (const file of manifest.files) {
		if (await checksum(join(path, file.path)) !== file.sha256) {
			throw new Error(`${file.path} does not match its checksum in backup.json`);
		}
	}
	const original = JSON.parse(readFileSync(join(path, "channel.json"), "utf8")) as catalog.Listing;
	const record: catalog.Listing = {
		...catalog.draft(await project(dir || original.project), original.model),
		name: catalog.restored(original.name),
		named: original.named !== false,
		summary: original.summary,
	};
	const { base, storage } = catalog.paths(record.id);
	mkdirSync(base, { recursive: true });
	try {
		const names = new Set(manifest.files.map((file) => file.path));
		if (names.has("snapshot.json")) {
			const db = await openNodeSqliteDatabase(storage);
			try {
				await importSnapshot(db, JSON.parse(readFileSync(join(path, "snapshot.json"), "utf8")));
			} finally {
				await db.close();
			}
		} else if (names.has("channel.sqlite")) {
			copyFileSync(join(path, "channel.sqlite"), storage);
		}
		if (record.project !== original.project) await offline(record, async () => {}, true);
		// Saved last: the catalog lists the channel only once its store is complete.
		catalog.save(record);
	} catch (error) {
		rmSync(base, { recursive: true, force: true });
		throw error;
	}
	// The restored store's own metadata still names the original, and it wins when the channel
	// opens, so the new name has to be committed there too.
	if (record.name !== original.name) {
		await request(record.id, { op: "rename", author: catalog.user, name: record.name });
	}
	return catalog.read(record.id);
}
