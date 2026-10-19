/**
 * Moving an idle channel between this host and a hosting service, or from this host to a cloud
 * workspace. The channel keeps its ID and lanes; its pi store travels as one verified snapshot. A `moving` fence on the record keeps
 * both copies from running while the move is under way, and an unknown activation keeps it.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

import { exportSnapshot, importSnapshot, MAX_SNAPSHOT, type Snapshot } from "@ace/channel/transfer";
import type { ChannelInfo } from "@ace/channel/protocol";

import * as catalog from "./catalog";
import { Connection, hostedAuth } from "./client";
import { adoption, available, start } from "./compute";
import * as directory from "./directory";
import { refusal } from "./http";
import { KEYCHAIN_WAITING } from "./keys";
import { log } from "./log";
import { hostedConfig, isWorkerAlive } from "./manage";
import type { MoveTarget } from "./protocol";

/** Services this host has moved channels to, so a channel that came back can leave again. */
const services = join(catalog.home, "services.json");

function known(): string[] {
	return existsSync(services) ? JSON.parse(readFileSync(services, "utf8")).hosted : [];
}

function remember(url: string): void {
	const hosted = known();
	if (!hosted.includes(url)) writeFileSync(services, JSON.stringify({ hosted: [...hosted, url] }));
}

/** A service base URL without a trailing slash, as hosted records store it. */
export function canonical(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("A hosting service URL starts with https://");
	}
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function movable(record: catalog.Listing): void {
	if (record.compute) {
		throw new Error("A cloud compute channel's workspace is its container, so it cannot move");
	}
	if (record.owner !== catalog.user) throw new Error("Only this host's owner can move channels");
	if (record.archived) throw new Error("Unarchive the channel before moving it");
	if (record.moving?.digest) {
		throw new Error(
			`The channel's move to ${record.moving.to} may have finished there; run the same move to ${record.moving.to} again to complete it`,
		);
	}
	if (record.moving) {
		throw new Error(
			`The channel is fenced by an unfinished move to ${record.moving.to}; find where it is active before lifting the fence`,
		);
	}
	if (record.busy) throw new Error("The channel is busy; stop its work before moving it");
}

/** The target that moves a local channel to a cloud workspace on the team's compute service. */
const COMPUTE = "compute";

export async function targets(id: string): Promise<MoveTarget[]> {
	const record = catalog.read(id);
	try {
		movable(record);
	} catch {
		return [];
	}
	if (record.hosted) {
		return [{ target: "local", label: `this host (${hostname()})`, place: "local" }];
	}
	const team = directory.read().hosted;
	const hosted = new Set([
		...(team ? [canonical(team)] : []),
		...catalog.list().flatMap((r) => r.hosted && !r.compute ? [r.hosted] : []),
		...known(),
	]);
	const services: MoveTarget[] = [...hosted].map((url) => ({
		target: url,
		label: hosted.size > 1 ? `cloud (${new URL(url).host})` : "cloud",
		place: "hosted",
	}));
	if (!(await available(record.project))) return services;
	return [...services, { target: COMPUTE, label: "cloud workspace", place: "cloud" }];
}

/** A transfer whose answer never arrived may still have taken effect at the service. */
class Unknown extends Error {}

type Auth = Record<string, string>;

/** Past this, a keychain prompt nobody answered fails the move instead of holding the request. */
const KEYCHAIN_WAIT = 2 * 60_000;

/**
 * A keychain prompt holds the read until someone answers it, so credentials are read before the
 * fence: the channel stays usable meanwhile, and `waiting` tells the app what the move waits on.
 */
async function credentials(waiting: (text: string | null) => void): Promise<Auth> {
	let announced = false;
	let timer: Timer | undefined;
	const slow = setTimeout(() => {
		announced = true;
		waiting(KEYCHAIN_WAITING);
	}, 1000);
	const read = hostedAuth();
	try {
		return await Promise.race([
			read,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					read.catch(() => {});
					reject(
						new Error(
							"Ace Helper is still waiting for keychain access. Allow it in the keychain prompt, then retry.",
						),
					);
				}, KEYCHAIN_WAIT);
			}),
		]);
	} finally {
		clearTimeout(slow);
		clearTimeout(timer);
		if (announced) waiting(null);
	}
}

function transfer<T>(auth: Auth, url: string, id: string, body: object): Promise<T> {
	return post<T>(auth, `${url}/channels/${id}/transfer`, body);
}

async function post<T>(auth: Auth, endpoint: string, body: object): Promise<T> {
	const url = new URL(endpoint).origin;
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		throw new Unknown(`Could not reach ${url}: ${(error as Error).message}.`);
	}
	if (response.ok) {
		try {
			return await response.json() as T;
		} catch (error) {
			throw new Unknown(`${url} answered without a readable result: ${(error as Error).message}.`);
		}
	}
	const message = await refusal(response, "The hosting service");
	throw response.status >= 500 ? new Unknown(message) : new Error(message);
}

/** A failed move says where the channel is now, since that decides what the person can do next. */
function stranded(error: unknown, where: string): Error {
	return new Error(`${(error as Error).message.replace(/[.\s]*$/, ".")} ${where}`, {
		cause: error,
	});
}

/** Worker startup checks the fence after taking this lock, so holding it keeps storage still. */
async function park(id: string): Promise<void> {
	if (isWorkerAlive(id)) {
		const connection = await Connection.running(id);
		if (connection) {
			try {
				await connection.request({ op: "freeze" });
				await connection.closed;
			} finally {
				connection.close();
			}
		}
	}
	for (let wait = 50; wait < 5000; wait *= 2) {
		if (catalog.lock(id)) return;
		await Bun.sleep(wait);
	}
	throw new Error("The channel's worker did not stop");
}

async function readLocal(id: string): Promise<Snapshot> {
	const db = await openNodeSqliteDatabase(catalog.paths(id).storage);
	try {
		return await exportSnapshot(db, id);
	} finally {
		await db.close();
	}
}

async function toHosted(auth: Auth, record: catalog.Listing, url: string): Promise<void> {
	const { id } = record;
	let digest = record.moving?.digest;
	if (!digest) {
		catalog.write({ ...record, moving: { to: url } });
		try {
			await park(id);
			const snapshot = await readLocal(id);
			if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT) {
				throw new Error("The channel is too large to move yet");
			}
			// An import, answered or not, leaves the service inactive, so the local copy stays usable.
			await transfer(auth, url, id, { action: "import", config: hostedConfig(record), snapshot });
			digest = snapshot.digest;
		} catch (error) {
			catalog.write({ ...catalog.read(id), moving: undefined });
			catalog.unlock(id);
			throw stranded(error, "The channel is still on this Mac.");
		}
		catalog.write({ ...catalog.read(id), moving: { to: url, digest } });
	}
	try {
		await transfer<ChannelInfo>(auth, url, id, { action: "activate", digest });
	} catch (error) {
		if (error instanceof Unknown) {
			throw stranded(
				error,
				"The channel may now be active there, so this copy stays fenced; run the same move again to finish it.",
			);
		}
		catalog.write({ ...catalog.read(id), moving: undefined });
		catalog.unlock(id);
		throw stranded(error, "The channel is still on this Mac.");
	}
	catalog.write({ ...catalog.read(id), hosted: url, moving: undefined, busy: false });
	catalog.unlock(id);
	remember(url);
}

/**
 * Like `toHosted`, except the compute service creates the workspace that adopts the channel, and
 * the channel stays stopped until its workspace starts.
 */
async function toCompute(
	auth: Auth,
	record: catalog.Listing,
	waiting: (text: string | null) => void,
): Promise<void> {
	const { id } = record;
	const { url, body } = await adoption(record);
	let digest = record.moving?.digest;
	if (!digest) {
		catalog.write({ ...record, moving: { to: COMPUTE } });
		try {
			await park(id);
			const snapshot = await readLocal(id);
			if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT) {
				throw new Error("The channel is too large to move yet");
			}
			await post(auth, `${url}/workspaces/${id}/import`, { ...body, snapshot });
			digest = snapshot.digest;
		} catch (error) {
			catalog.write({ ...catalog.read(id), moving: undefined });
			catalog.unlock(id);
			throw stranded(error, "The channel is still on this Mac.");
		}
		catalog.write({ ...catalog.read(id), moving: { to: COMPUTE, digest } });
	}
	try {
		await transfer<ChannelInfo>(auth, url, id, { action: "activate", digest });
	} catch (error) {
		if (error instanceof Unknown) {
			throw stranded(
				error,
				"The channel may now be active there, so this copy stays fenced; run the same move again to finish it.",
			);
		}
		catalog.write({ ...catalog.read(id), moving: undefined });
		catalog.unlock(id);
		throw stranded(error, "The channel is still on this Mac.");
	}
	catalog.write({
		...catalog.read(id),
		hosted: url,
		compute: true,
		stopped: true,
		moving: undefined,
		busy: false,
	});
	catalog.unlock(id);
	try {
		await start(id, waiting);
	} catch (error) {
		throw new Error(
			`Moved to the cloud workspace, but it did not start: ${
				(error as Error).message.replace(/[.\s]*$/, ".")
			} Start compute retries it.`,
			{ cause: error },
		);
	}
}

async function toLocal(auth: Auth, record: catalog.Listing): Promise<void> {
	const { id } = record;
	const url = record.hosted!;
	const { storage } = catalog.paths(id);
	const incoming = `${storage}.incoming`;
	catalog.write({ ...record, moving: { to: "local" } });
	// A refused or unanswered freeze may still have frozen the service; thawing an active one is refused.
	let freezing = false;
	try {
		await park(id);
		freezing = true;
		const { digest } = await transfer<{ digest: string }>(auth, url, id, { action: "freeze" });
		const snapshot = await transfer<Snapshot>(auth, url, id, { action: "export" });
		if (snapshot.digest !== digest) {
			throw new Error("The exported snapshot does not match the frozen channel");
		}
		for (const path of [incoming, `${incoming}-wal`, `${incoming}-shm`]) {
			rmSync(path, { force: true });
		}
		const db = await openNodeSqliteDatabase(incoming);
		try {
			await importSnapshot(db, snapshot);
		} finally {
			await db.close();
		}
		// The parked copy's journal belongs to older history; it must not replay over the new store.
		for (const path of [`${storage}-wal`, `${storage}-shm`]) rmSync(path, { force: true });
		renameSync(incoming, storage);
	} catch (error) {
		if (freezing) {
			await transfer(auth, url, id, { action: "thaw" }).catch((cause: Error) =>
				log("warn", "move.thaw.failed", { channel: id, error: cause.message })
			);
		}
		catalog.write({ ...catalog.read(id), moving: undefined });
		catalog.unlock(id);
		throw stranded(error, `The channel is still on ${new URL(url).host}.`);
	}
	catalog.write({ ...catalog.read(id), hosted: undefined, moving: undefined, busy: false });
	catalog.unlock(id);
}

/** The channel's record, if it can move to `to` now: "local", "compute", or a canonical service URL. */
function ready(id: string, to: string): catalog.Listing {
	const record = catalog.read(id);
	// Only an outbound move whose activation went unanswered resumes; anything else starts fresh.
	if (!(record.moving?.digest && record.moving.to === to)) movable(record);
	if (to === "local" && !record.hosted) throw new Error("The channel is already on this host");
	if (to !== "local" && record.hosted) throw new Error("Move the channel to this host first");
	return record;
}

/**
 * Move a channel to `target`: "local", "compute", or a hosting service URL. The frozen source is
 * kept, not deleted.
 */
export async function move(
	id: string,
	target: string,
	waiting: (text: string | null) => void = () => {},
): Promise<void> {
	const to = target === "local" || target === COMPUTE ? target : canonical(target);
	ready(id, to);
	const auth = await credentials(waiting);
	// The record may have changed during the wait; nothing from here awaits before the fence.
	const record = ready(id, to);
	log("info", "move.start", { channel: id, from: record.hosted || "local", to });
	if (to === "local") await toLocal(auth, record);
	else if (to === COMPUTE) await toCompute(auth, record, waiting);
	else await toHosted(auth, record, to);
	log("info", "move.done", { channel: id, to });
}
