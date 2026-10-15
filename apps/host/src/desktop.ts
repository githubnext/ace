import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Desktop } from "@ace/channel/desktop";
import { createDesktop, type DesktopClient } from "@githubnext/desktop-tools";

import { config } from "./config";

let client: DesktopClient | undefined;

export const desktop: Desktop = async (request, context) => {
	// Whichever process started this worker, only the app serving this data directory's socket
	// knows which signed client it accepts, so it publishes that client beside the socket.
	const path = join(config.home, "desktop-client");
	if (!existsSync(path)) throw new Error("Open Ace on this host to enable native desktop tools.");
	client ??= createDesktop({
		client: path,
		socket: join(config.home, "desktop.sock"),
		name: "Ace",
	});
	// Hosted links and pi rows carry only the bounded text and image, not the parsed copy.
	const { text, image, outcome, isError } = await client(request, context.abortSignal);
	return {
		text,
		...(image ? { image } : {}),
		...(outcome ? { outcome } : {}),
		...(isError === undefined ? {} : { isError }),
	};
};
