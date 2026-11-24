import { Console } from "node:console";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { adoptLoginShell } from "./environment";

declare const ACE_IDENTIFIER: string;
declare const ACE_PROFILE: string | undefined;
declare const ACE_VERSION: string;

const helpers = join(dirname(process.execPath), "..", "Helpers");
// launchd and the host start this executable as Ace Helper; any other name is a link the app
// installed for the command line, which runs the CLI against this app's data and port.
const cli = basename(process.argv0) !== "Ace Helper";
const worker = process.argv[2] === "--worker";
// A terminal already has the person's environment; only launchd's helper needs the login shell's.
if (cli) process.env.PATH = `${helpers}:${process.env.PATH}`;
else if (!worker) adoptLoginShell(helpers);

const { config, desktop } = await import("./config");
desktop(ACE_IDENTIFIER, ACE_PROFILE);
config.helper = !cli;
config.version = ACE_VERSION;
config.app = join(dirname(process.execPath), "..", "Resources", "app", "web");
config.services = join(dirname(process.execPath), "..", "Resources", "services");
config.worker = [process.execPath, "--worker"];
config.cli = [process.execPath];
// The app links its command as `ace` for stable and `ace-<channel>` otherwise, as its identifier ends.
config.command = cli
	? basename(process.argv0)
	: ACE_IDENTIFIER.replace("dev.ace.desktop", "ace").replace(".", "-");

if (cli) {
	await import("./cli");
} else if (worker) {
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
		// The installed app takes no flags, so a demo script in its home stands in for --demo.
		const demo = join(config.home, "demo.json");
		await serve(config.port, false, existsSync(demo) ? demo : undefined);
	} catch (error) {
		console.error(error);
		log.end(() => process.exit(1));
	}
}
