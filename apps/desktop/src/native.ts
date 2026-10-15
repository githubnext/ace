import { renameSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { CString, dlopen, type Pointer } from "bun:ffi";

import { config } from "@ace/host/config";

import type { NativeAction, NativeState } from "./protocol";

export function native(identifier: string) {
	const bin = dirname(process.execPath);
	const { symbols } = dlopen(join(bin, "libDesktopTools.dylib"), {
		desktop_tools_start: { args: ["cstring", "cstring"], returns: "void" },
		desktop_tools_status: { args: [], returns: "ptr" },
		desktop_tools_stop: { args: [], returns: "void" },
		desktop_tools_free: { args: ["ptr"], returns: "void" },
		desktop_tools_permission: { args: ["cstring"], returns: "void" },
	});
	const { symbols: picker } = dlopen(join(bin, "libAceProject.dylib"), {
		ace_project_open: { args: [], returns: "void" },
		ace_project_close: { args: [], returns: "void" },
		ace_project_start: { args: ["cstring"], returns: "void" },
		ace_project_status: { args: [], returns: "ptr" },
		ace_project_free: { args: ["ptr"], returns: "void" },
	});
	let pending: Promise<string | null> | undefined;

	function read<T>(pointer: Pointer | null, free: (pointer: Pointer) => void): T {
		if (!pointer) throw new Error("Could not read native desktop response");
		try {
			return JSON.parse(new CString(pointer).toString()) as T;
		} finally {
			free(pointer);
		}
	}

	function status(): NativeState {
		return read(symbols.desktop_tools_status(), symbols.desktop_tools_free);
	}

	async function project(path: string): Promise<string | null> {
		picker.ace_project_start(Buffer.from(`${path}\0`));
		while (true) {
			const result = read<{ pending: boolean; path: string | null; error?: string }>(
				picker.ace_project_status(),
				picker.ace_project_free,
			);
			if (result.error) throw new Error(result.error);
			if (!result.pending) return result.path;
			await Bun.sleep(50);
		}
	}

	return {
		status,
		project(path: string): Promise<string | null> {
			if (pending) return pending;
			pending = project(path).finally(() => pending = undefined);
			return pending;
		},
		start() {
			picker.ace_project_open();
			// Workers find the client the socket accepts here, including those a source CLI starts.
			const link = join(config.home, "desktop-client");
			symlinkSync(join(bin, "ace-desktop-client"), `${link}.${process.pid}`);
			renameSync(`${link}.${process.pid}`, link);
			symbols.desktop_tools_start(
				Buffer.from(`${join(config.home, "desktop.sock")}\0`),
				Buffer.from(`${identifier}.desktop-client\0`),
			);
		},
		act(action: NativeAction): NativeState {
			if (action.op === "permission") {
				if (
					!["accessibility", "screenRecording", "eventSynthesizing"].includes(action.permission)
				) {
					throw new Error("Unknown native desktop permission");
				}
				symbols.desktop_tools_permission(Buffer.from(`${action.permission}\0`));
			}
			return status();
		},
		async stop(): Promise<void> {
			if (status().state === "stopped") return;
			picker.ace_project_close();
			symbols.desktop_tools_stop();
			// Keep the library loaded while its bridge drains outstanding native operations.
			const deadline = Date.now() + 30_000;
			while (status().state !== "stopped") {
				if (Date.now() > deadline) throw new Error("Native desktop tools did not stop in time");
				await Bun.sleep(50);
			}
		},
	};
}
