import { useEffect, useState, useSyncExternalStore } from "react";

import { host } from "./host";

/** The host's projects folder, where clones go by default; unknown until read or on older hosts. */
export function useFolder(): { folder?: string; error?: string } {
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const version = useSyncExternalStore(host.subscribe, () => host.settingsVersion);
	const [result, setResult] = useState<{ folder?: string; error?: string }>({});
	useEffect(() => {
		if (status !== "open") return;
		let active = true;
		host.request<string>({ op: "folder" }).then(
			(folder) => active && setResult({ folder }),
			(error: Error) => active && setResult({ error: error.message }),
		);
		return () => {
			active = false;
		};
	}, [status, version]);
	return result;
}
