import { dirname, join } from "node:path";

import { dlopen, JSCallback } from "bun:ffi";

const { symbols } = dlopen(join(dirname(process.execPath), "ace-notify.dylib"), {
	ace_notify_start: { args: ["function"], returns: "void" },
	ace_notify_clicked: { args: [], returns: "cstring" },
	ace_notify: { args: ["cstring", "cstring", "cstring"], returns: "void" },
});

const text = (value: string) => Buffer.from(`${value}\0`);

/** Desktop notifications whose click calls `clicked` with what the notification was about. */
export function notifications(clicked: (target: string) => void) {
	// Clicks arrive on the main thread; a threadsafe callback runs this on Bun's.
	const callback = new JSCallback(() => clicked(symbols.ace_notify_clicked().toString()), {
		args: [],
		returns: "void",
		threadsafe: true,
	});
	symbols.ace_notify_start(callback.ptr);
	return (title: string, body: string, target = "") =>
		symbols.ace_notify(text(title), text(body), text(target));
}
