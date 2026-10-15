import { token } from "./auth";
import { config } from "./config";
import { GatewayClient } from "./gateway-client";
import { health } from "./health";
import type { HostRequest } from "./protocol";

export function within<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error("The host did not answer within 10 seconds")),
			10_000,
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** This host's running gateway, authenticated as its owner over loopback. */
export async function gateway(port = config.port): Promise<GatewayClient> {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid host port");
	const info = await health(port);
	if (!info || info.home !== config.home) {
		throw new Error("Open Ace or start this host with ace serve first");
	}
	const client = new GatewayClient(`ws://127.0.0.1:${port}/ws`, token());
	const opened = Promise.withResolvers<void>();
	const check = () => {
		if (client.status === "open") opened.resolve();
		if (client.status === "closed") opened.reject(new Error("Disconnected from the host"));
	};
	const unsubscribe = client.subscribe(check);
	try {
		check();
		await within(opened.promise);
		return client;
	} catch (error) {
		client.close();
		throw error;
	} finally {
		unsubscribe();
	}
}

export async function local<T>(request: HostRequest, port?: number): Promise<T> {
	const client = await gateway(port);
	try {
		return await within(client.request<T>(request));
	} finally {
		client.close();
	}
}
