import { token } from "@ace/host/auth";
import { config } from "@ace/host/config";
import { GatewayClient } from "@ace/host/gateway-client";
import type { HostRequest } from "@ace/host/protocol";

export type DemoAction = Extract<HostRequest, { op: "demo" }>["action"];

/** The host's `ace demo` script, or null when it runs none. */
export async function demo(action: DemoAction): Promise<{ paused: boolean } | null> {
	const client = new GatewayClient(`ws://127.0.0.1:${config.port}/ws`, token());
	try {
		const deadline = Date.now() + 5000;
		while (client.status !== "open") {
			if (Date.now() > deadline) throw new Error("Could not connect to Ace Helper");
			await Bun.sleep(50);
		}
		return await client.request<{ paused: boolean } | null>({ op: "demo", action });
	} finally {
		client.close();
	}
}
