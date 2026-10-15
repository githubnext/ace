import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

import { serve, type WorkspaceMessage } from "@ace/channel/workspace";

import * as catalog from "./catalog";
import { hostedSocket } from "./client";
import { browser } from "./browser";
import { desktop } from "./desktop";
import { images } from "./images";
import { failure, log } from "./log";

/**
 * A hosted channel's tools run here. The host dials out, so it needs no inbound route; while it
 * is disconnected the channel stays reachable and its tools report the workspace as offline.
 */
function link(record: catalog.Listing): () => Promise<void> {
	const envs = new Map<string, NodeExecutionEnv>();
	const env = (cwd: string) => {
		let found = envs.get(cwd);
		if (!found) envs.set(cwd, found = new NodeExecutionEnv({ cwd }));
		return found;
	};
	let stopped = false;
	let socket: WebSocket | undefined;
	let wait = 1000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopCalls: (() => Promise<void>) | undefined;
	catalog.busy(record.id, false);
	const connect = async () => {
		if (stopped) return;
		try {
			const connected = await hostedSocket(record.hosted!, `/channels/${record.id}/workspace`);
			if (stopped) return connected.close();
			socket = connected;
			connectedChannels.add(record.id);
			wait = 1000;
			log("info", "workspace.connect", { channel: record.id, hosted: record.hosted });
			const handle = serve(env, (reply) => {
				if (connected.readyState === WebSocket.OPEN) connected.send(JSON.stringify(reply));
			}, { desktop, browser, images });
			stopCalls = () => handle.close();
			socket.addEventListener("message", ({ data }) => {
				if (stopped || socket !== connected) return;
				const call = JSON.parse(String(data)) as WorkspaceMessage;
				if ("metadata" in call) return catalog.metadata(record.id, call.metadata);
				if ("active" in call) return catalog.activity(record.id, call.active);
				if ("busy" in call) return catalog.busy(record.id, call.busy);
				if ("ran" in call) return catalog.ran(record.id, call.ran);
				log("debug", "workspace.call", {
					channel: record.id,
					...("cancel" in call
						? { cancel: call.cancel }
						: { call: call.call, method: call.method }),
				});
				handle(call);
			});
			socket.addEventListener("close", ({ code, reason }) => {
				void handle.close();
				log("warn", "workspace.drop", { channel: record.id, code, reason, stopped });
				// A stopped link may already have been replaced after unarchiving the channel.
				if (stopped) return;
				socket = undefined;
				connectedChannels.delete(record.id);
				if (catalog.owns(record.id)) catalog.busy(record.id, false);
				timer = setTimeout(connect, wait);
			});
		} catch (error) {
			if (stopped) return;
			log("warn", "workspace.failed", { channel: record.id, retry: wait, ...failure(error) });
			wait = Math.min(wait * 2, 30_000);
			timer = setTimeout(connect, wait);
		}
	};
	connect();
	return async () => {
		stopped = true;
		connectedChannels.delete(record.id);
		// Removal may already have deleted the catalog before its watcher stops the link.
		if (catalog.owns(record.id)) catalog.busy(record.id, false);
		clearTimeout(timer);
		socket?.close();
		await stopCalls?.();
		await Promise.all([...envs.values()].map((found) => found.cleanup(BACKGROUND_CONTEXT)));
	};
}

const links = new Map<string, () => Promise<void>>();
const connectedChannels = new Set<string>();

export function isConnected(id: string): boolean {
	return connectedChannels.has(id);
}

export async function close(): Promise<void> {
	const closing = [...links.values()].map((stop) => stop());
	links.clear();
	await Promise.all(closing);
}

/** Serve the workspace of every hosted channel in this host's catalog. */
export function sync(): void {
	const wanted = new Map(
		catalog.list().filter((record) => record.hosted && !record.archived).map((r) => [r.id, r]),
	);
	for (const [id, stop] of links) {
		if (!wanted.has(id)) {
			void stop().catch((error) => console.error(error));
			links.delete(id);
		}
	}
	for (const [id, record] of wanted) if (!links.has(id)) links.set(id, link(record));
}
