import { Console } from "node:console";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { adoptLoginShell } from "./environment";

declare const ACE_IDENTIFIER: string;
declare const ACE_PROFILE: string | undefined;

const worker = process.argv[2] === "--worker";
if (!worker) {
	adoptLoginShell();
	// Agents and the commit hooks they run use the lane CLI this bundle ships and was built against.
	process.env.PATH = `${join(dirname(process.execPath), "..", "Helpers")}:${process.env.PATH}`;
}

const { config, desktop } = await import("./config");
desktop(ACE_IDENTIFIER, ACE_PROFILE);
config.helper = true;
config.app = join(dirname(process.execPath), "..", "Resources", "app", "web");
config.worker = [process.execPath, "--worker"];

if (worker) {
	// A compiled executable dispatches its worker entry itself, rather than running a TS file.
	process.argv.splice(2, 1);
	await import("./worker");
} else {
	mkdirSync(config.home, { recursive: true });
	const log = createWriteStream(join(config.home, "helper.log"), { flags: "a" });
	Object.assign(console, new Console({ stdout: log, stderr: log }));
	console.log(`${new Date().toISOString()} Ace Helper starting`);
	try {
		const { serve } = await import("./gateway");
		await serve(config.port);
	} catch (error) {
		console.error(error);
		log.end(() => process.exit(1));
	}
}
