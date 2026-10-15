import { useEffect, useSyncExternalStore } from "react";

import type { HostRequest } from "@ace/host/protocol";

import { host, onOpen } from "./host";
import type { AppProject } from "./projects";

type Request = Extract<HostRequest, { op: "project-repo" | "github-list" }>;
type Snapshot = { value?: unknown; error?: string; loading: boolean };
type Saved = { key: string; request: Request; value: unknown };
type Entry = {
	key: string;
	request: Request;
	snapshot: Snapshot;
	checked: number;
	running?: Promise<void>;
	listeners: Set<() => void>;
	subscribe: (listener: () => void) => () => void;
	read: () => Snapshot;
};

export type Query<T> = { value?: T; error?: string; loading: boolean; refresh: () => void };

const INTERVAL = 3 * 60 * 60 * 1000;
const EMPTY: Snapshot = { loading: true };
const cache = new Map<string, Entry>();
const database = new Promise<IDBDatabase>((resolve, reject) => {
	const request = indexedDB.open(`ace:github:${host.url}`, 2);
	request.addEventListener("upgradeneeded", (event) => {
		if (event.oldVersion < 1) {
			return request.result.createObjectStore("queries", { keyPath: "key" });
		}
		// Version 1 also saved inline item details, which background refresh would keep requesting.
		const cursor = request.transaction!.objectStore("queries").openCursor();
		cursor.addEventListener("success", () => {
			const saved = cursor.result;
			if (!saved) return;
			if (!["project-repo", "github-list"].includes((saved.value as Saved).request.op)) {
				saved.delete();
			}
			saved.continue();
		});
	});
	request.addEventListener("success", () => {
		request.result.addEventListener("versionchange", () => request.result.close());
		resolve(request.result);
	});
	request.addEventListener("error", () => reject(request.error));
}).catch(() => undefined);

/** Storage failure leaves the shared memory cache usable. */
async function stored<T>(
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
	try {
		const db = await database;
		if (!db) return;
		return await new Promise<T>((resolve, reject) => {
			const transaction = db.transaction("queries", mode);
			const request = operation(transaction.objectStore("queries"));
			transaction.addEventListener("complete", () => resolve(request.result));
			transaction.addEventListener("abort", () => reject(transaction.error));
			transaction.addEventListener("error", () => reject(transaction.error));
		});
	} catch {
		return undefined;
	}
}

function entry(request: Request): Entry {
	if ("repo" in request) request = { ...request, repo: request.repo.toLowerCase() };
	const key = JSON.stringify(request, Object.keys(request).sort());
	const existing = cache.get(key);
	if (existing) return existing;
	const value: Entry = {
		key,
		request,
		snapshot: EMPTY,
		checked: 0,
		listeners: new Set(),
		subscribe(listener) {
			value.listeners.add(listener);
			return () => void value.listeners.delete(listener);
		},
		read: () => value.snapshot,
	};
	cache.set(key, value);
	return value;
}

function publish(value: Entry, snapshot: Snapshot) {
	value.snapshot = snapshot;
	for (const listener of value.listeners) listener();
}

const ready = stored<Saved[]>("readonly", (store) => store.getAll()).then((saved) => {
	for (const value of saved || []) {
		publish(entry(value.request), { value: value.value, loading: false });
	}
});

async function load(value: Entry, force = false): Promise<void> {
	await ready;
	if (value.running) return value.running;
	if (host.status !== "open") return;
	if (!force && Date.now() - value.checked < INTERVAL) return;
	value.checked = Date.now();
	value.running = host.request(value.request).then(
		(result) => {
			publish(value, { value: result, loading: false });
			void stored(
				"readwrite",
				(store) =>
					store.put({ key: value.key, request: value.request, value: result } satisfies Saved),
			);
		},
		(error: Error) => {
			publish(value, { ...value.snapshot, error: error.message, loading: false });
		},
	).finally(() => {
		value.running = undefined;
	});
	publish(value, { ...value.snapshot, error: undefined, loading: true });
	return value.running;
}

let refreshing: Promise<void> | undefined;
/**
 * The sidebar's projects that a host can answer for. Saved and page-only queries stay out, so
 * projects that left the sidebar or moved hosts aren't asked again; a Set visits additions mid-loop.
 */
const wanted = new Set<Entry>();

/** Warm both pages without mounting them, and serialize background GitHub requests. */
function refresh(force = false): Promise<void> {
	if (refreshing) return refreshing;
	refreshing = (async () => {
		await ready;
		for (const value of wanted) {
			if (host.status !== "open") break;
			await load(value, force);
			const repo = value.snapshot.value as string | null | undefined;
			if (!repo) continue;
			for (const kind of ["issues", "prs"] as const) {
				for (const state of ["open", "closed", "all"] as const) {
					await load(entry({ op: "github-list", repo, kind, state, search: "", limit: 50 }), force);
				}
			}
		}
	})().finally(() => {
		refreshing = undefined;
	});
	return refreshing;
}

export function useGithubRefresh(projects: AppProject[]) {
	const source = JSON.stringify(
		projects.filter((project) => project.reachable).map(({ host, path }) => ({
			op: "project-repo",
			host,
			project: path,
		})),
	);
	useEffect(() => {
		wanted.clear();
		for (const request of JSON.parse(source) as Request[]) wanted.add(entry(request));
		void refresh();
	}, [source]);
	useEffect(() => {
		const connected = () => {
			for (const value of cache.values()) {
				if (value.snapshot.error) value.checked = 0;
			}
			void refresh();
		};
		const wake = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		const stop = onOpen(connected);
		const timer = setInterval(() => void refresh(true), INTERVAL);
		window.addEventListener("focus", wake);
		document.addEventListener("visibilitychange", wake);
		if (host.status === "open") connected();
		return () => {
			stop();
			clearInterval(timer);
			window.removeEventListener("focus", wake);
			document.removeEventListener("visibilitychange", wake);
		};
	}, []);
}

const inactive = { subscribe: () => () => {}, read: () => EMPTY };

export function useGithub<T>(request?: Request): Query<T> {
	const value = request ? entry(request) : undefined;
	const store = value || inactive;
	const snapshot = useSyncExternalStore(store.subscribe, store.read);
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	useEffect(() => {
		if (value && status === "open") void load(value);
	}, [value, status]);
	return {
		value: snapshot.value as T | undefined,
		error: !value ? undefined : status !== "open"
			? "Connect to your host to refresh GitHub."
			: snapshot.error,
		loading: !!value && status === "open" && snapshot.loading,
		refresh: () => {
			if (value) void load(value, true);
		},
	};
}
