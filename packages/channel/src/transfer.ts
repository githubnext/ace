/**
 * A channel's complete pi state as one JSON value, for moving it between a host and a hosted cell.
 * pi's SQLite schema stays authoritative: snapshots carry exactly its current tables and refuse any
 * other schema version, so a move never translates or migrates data.
 */
import {
	applySqliteMigrations,
	CURRENT_SQLITE_SCHEMA_VERSION,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

declare function btoa(data: string): string;
declare function atob(data: string): string;
declare const crypto: {
	subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
};
declare class TextEncoder {
	encode(input: string): Uint8Array;
}

/** JSON carries bytes as base64 and integers beyond 2^53 as decimal strings. */
export type Cell = null | number | string | { b64: string } | { int: string };

export type Snapshot = {
	format: "ace-channel-snapshot";
	version: 1;
	channel: string;
	schema: number;
	tables: Record<string, { columns: string[]; rows: Cell[][] }>;
	/** SHA-256 hex of the canonical encoding of everything above. */
	digest: string;
};

/** Requests and responses carry the whole snapshot in one body. */
export const MAX_SNAPSHOT = 32 * 1024 * 1024;

/**
 * The pi schema version `TABLES` describes. A newer pi may add columns this list would silently
 * drop, so moves refuse until it is updated for that version.
 */
const SCHEMA = 1;

function pinned(): void {
	if (CURRENT_SQLITE_SCHEMA_VERSION !== SCHEMA) {
		throw new Error(
			`Channel moves support pi schema ${SCHEMA}; this runtime has ${CURRENT_SQLITE_SCHEMA_VERSION}`,
		);
	}
}

/** pi schema version 1, in insertion order; `key` orders rows without relying on rowid. */
const TABLES: Record<string, { columns: string[]; key: string[] }> = {
	durable_schema: { columns: ["singleton", "version"], key: ["singleton"] },
	durable_metadata: { columns: ["singleton", "next_id", "next_seq"], key: ["singleton"] },
	record_ids: { columns: ["id", "record_type"], key: ["id"] },
	conversations: {
		columns: ["id", "owner_conversation_id", "owner_task_id", "record"],
		key: ["id"],
	},
	entries: { columns: ["id", "conversation_id", "head", "commit_seq", "record"], key: ["id"] },
	tasks: {
		columns: ["id", "conversation_id", "kind", "status", "abort_requested", "background", "record"],
		key: ["id"],
	},
	submissions: {
		columns: ["id", "conversation_id", "request_id", "status", "record"],
		key: ["id"],
	},
	documents: {
		columns: [
			"id",
			"kind",
			"family",
			"key_value",
			"scope_kind",
			"owner_id",
			"created_at",
			"retired_at",
			"record",
		],
		key: ["id"],
	},
	document_revisions: {
		columns: ["document_id", "seq", "kind", "version", "content"],
		key: ["document_id", "seq"],
	},
};
const NAMES = Object.keys(TABLES);
/** What `applySqliteMigrations` seeds into a new database. */
const SEED = JSON.stringify({
	durable_schema: [[1, SCHEMA]],
	durable_metadata: [[1, "2", 1]],
});
// Durable Objects keep their KV API in `__cf_kv`, local `wrangler dev` adds `__miniflare_do_name`,
// and SQLite keeps its own `sqlite_*` tables.
const INTERNAL = /^(sqlite_|_cf_|__cf_|__miniflare_)/i;

function encode(value: unknown): Cell {
	if (value === null || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`Unsupported SQLite number ${value}`);
		return value;
	}
	if (typeof value === "bigint") {
		return Number.isSafeInteger(Number(value)) ? Number(value) : { int: value.toString() };
	}
	if (value instanceof Uint8Array) {
		let binary = "";
		for (let i = 0; i < value.length; i += 0x8000) {
			binary += String.fromCharCode(...value.subarray(i, i + 0x8000));
		}
		return { b64: btoa(binary) };
	}
	throw new Error(`Unsupported SQLite value ${typeof value}`);
}

function decode(cell: unknown): SqliteValue {
	if (cell === null || typeof cell === "string") return cell;
	if (typeof cell === "number" && Number.isFinite(cell)) return cell;
	if (typeof cell === "object") {
		const keys = Object.keys(cell);
		if (keys.length === 1 && "b64" in cell && typeof cell.b64 === "string") {
			return Uint8Array.from(atob(cell.b64), (c) => c.charCodeAt(0));
		}
		if (
			keys.length === 1 && "int" in cell && typeof cell.int === "string" && /^-?\d+$/.test(cell.int)
		) {
			return BigInt(cell.int);
		}
	}
	throw new Error(`Snapshot has an unsupported cell ${JSON.stringify(cell)}`);
}

/** Canonical encoding: fixed field and table order, rows in primary-key order. */
function canonical(snapshot: Omit<Snapshot, "digest">): string {
	return JSON.stringify([
		snapshot.format,
		snapshot.version,
		snapshot.channel,
		snapshot.schema,
		NAMES.map((name) => [name, snapshot.tables[name]!.columns, snapshot.tables[name]!.rows]),
	]);
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function seal(body: Omit<Snapshot, "digest">): Promise<Snapshot> {
	const bytes = new TextEncoder().encode(canonical(body));
	if (bytes.byteLength > MAX_SNAPSHOT) {
		throw new Error(
			`The channel is larger than the ${
				MAX_SNAPSHOT / 1024 / 1024
			} MiB snapshot limit, so it cannot be moved or backed up`,
		);
	}
	return { ...body, digest: await sha256(bytes) };
}

/** Refuses databases holding anything but pi's tables, or another pi schema version. */
async function check(db: SqliteExecutor): Promise<void> {
	const tables = await db.all<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table'",
	);
	const found = new Set(tables.map(({ name }) => name).filter((name) => !INTERNAL.test(name)));
	const extra = [...found].filter((name) => !(name in TABLES));
	if (extra.length) throw new Error(`Channel database has unknown tables: ${extra.join(", ")}`);
	const missing = NAMES.filter((name) => !found.has(name));
	if (missing.length) throw new Error(`Channel database lacks pi tables: ${missing.join(", ")}`);
	const row = await db.get<{ version: number | bigint }>(
		"SELECT version FROM durable_schema WHERE singleton = 1",
	);
	if (Number(row?.version) !== SCHEMA) {
		throw new Error(
			`Channel database has pi schema ${row?.version}; moves support ${SCHEMA}`,
		);
	}
}

async function read(db: SqliteExecutor, channel: string): Promise<Snapshot> {
	await check(db);
	const tables: Snapshot["tables"] = {};
	for (const name of NAMES) {
		const { columns, key } = TABLES[name]!;
		const rows = await db.all<Record<string, unknown>>(
			`SELECT ${columns.join(", ")} FROM ${name} ORDER BY ${key.join(", ")}`,
		);
		tables[name] = {
			columns,
			rows: rows.map((row) => columns.map((column) => encode(row[column]))),
		};
	}
	return seal({
		format: "ace-channel-snapshot",
		version: 1,
		channel,
		schema: SCHEMA,
		tables,
	});
}

/**
 * Whether pi still holds queued or running work. Moves carry only settled channels; a snapshot
 * with live tasks would resume them at the destination.
 */
export async function isUnsettled(db: SqliteExecutor): Promise<boolean> {
	const task = await db.get("SELECT id FROM tasks WHERE status != 'terminal' LIMIT 1");
	const submission = await db.get(
		"SELECT id FROM submissions WHERE status IN ('queued', 'placed') LIMIT 1",
	);
	return !!(task || submission);
}

/** One consistent read of a closed, settled channel database. */
export async function exportSnapshot(db: SqliteDatabase, channel: string): Promise<Snapshot> {
	pinned();
	return db.transaction(async (tx) => {
		if (await isUnsettled(tx)) {
			throw new Error("Channel has unfinished work; wait until it is idle");
		}
		return read(tx, channel);
	});
}

/**
 * One consistent read of a channel database, including unfinished work: a backup records the
 * channel as it is, and a restored copy resumes that work when it opens.
 */
export async function backupSnapshot(db: SqliteDatabase, channel: string): Promise<Snapshot> {
	pinned();
	return db.transaction((tx) => read(tx, channel));
}

function validate(snapshot: Snapshot): void {
	if (snapshot?.format !== "ace-channel-snapshot" || snapshot.version !== 1) {
		throw new Error("Not a version 1 Ace channel snapshot");
	}
	if (snapshot.schema !== SCHEMA) {
		throw new Error(
			`Snapshot has pi schema ${snapshot.schema}; moves support ${SCHEMA}`,
		);
	}
	if (typeof snapshot.channel !== "string" || typeof snapshot.digest !== "string") {
		throw new Error("Snapshot lacks its channel or digest");
	}
	const names = Object.keys(snapshot.tables || {});
	if (names.length !== NAMES.length || names.some((name) => !(name in TABLES))) {
		throw new Error("Snapshot tables do not match pi's schema");
	}
	for (const name of NAMES) {
		const { columns, rows } = snapshot.tables[name]!;
		if (JSON.stringify(columns) !== JSON.stringify(TABLES[name]!.columns) || !Array.isArray(rows)) {
			throw new Error(`Snapshot table ${name} does not match pi's schema`);
		}
		for (const row of rows) {
			if (!Array.isArray(row) || row.length !== columns.length) {
				throw new Error(`Snapshot table ${name} has a malformed row`);
			}
		}
	}
}

/**
 * Writes a snapshot into a database in one transaction, then re-reads it and refuses unless the
 * stored state hashes to the snapshot's digest. The destination must hold no pi records beyond
 * the schema seed, unless `replace` is set by a caller that has already established the
 * destination is a frozen or inactive copy of this same channel. `install` runs inside the same
 * transaction after verification, so callers can record the import atomically with it.
 */
export async function importSnapshot(
	db: SqliteDatabase,
	snapshot: Snapshot,
	options: { replace?: boolean; install?: (tx: SqliteExecutor) => Promise<void> } = {},
): Promise<{ digest: string; counts: Record<string, number> }> {
	pinned();
	validate(snapshot);
	const { digest, ...body } = snapshot;
	const sealed = await seal(body);
	if (sealed.digest !== digest) throw new Error("Snapshot digest does not match its contents");
	const rows = NAMES.map((name) => snapshot.tables[name]!.rows.map((row) => row.map(decode)));
	await applySqliteMigrations(db);
	return db.transaction(async (tx) => {
		const current = await read(tx, snapshot.channel);
		if (!options.replace) {
			const seeded = JSON.stringify({
				durable_schema: current.tables.durable_schema!.rows,
				durable_metadata: current.tables.durable_metadata!.rows,
			});
			const empty = NAMES.every((name) =>
				name.startsWith("durable_") || !current.tables[name]!.rows.length
			);
			if (!empty || seeded !== SEED) throw new Error("Destination channel database is not empty");
		}
		for (const name of NAMES.toReversed()) await tx.run(`DELETE FROM ${name}`);
		for (const [index, name] of NAMES.entries()) {
			const { columns } = TABLES[name]!;
			const sql = `INSERT INTO ${name} (${columns.join(", ")}) VALUES (${
				columns.map(() => "?").join(", ")
			})`;
			for (const row of rows[index]!) await tx.run(sql, ...row);
		}
		const stored = await read(tx, snapshot.channel);
		if (stored.digest !== digest) {
			throw new Error("Imported channel does not match the snapshot digest");
		}
		await options.install?.(tx);
		return {
			digest,
			counts: Object.fromEntries(NAMES.map((name) => [name, snapshot.tables[name]!.rows.length])),
		};
	});
}
