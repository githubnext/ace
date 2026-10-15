import { useEffect, useState, useSyncExternalStore } from "react";

import type { Compute } from "@ace/host/protocol";

import { host } from "./host";

/** The cloud compute beta's settings; an older or remote host refuses and leaves it off. */
export function useCompute(): { compute?: Compute; error?: string } {
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const version = useSyncExternalStore(host.subscribe, () => host.settingsVersion);
	const [result, setResult] = useState<{ compute?: Compute; error?: string }>({});
	useEffect(() => {
		if (status !== "open") return;
		let active = true;
		host.request<Compute>({ op: "compute" }).then(
			(compute) => active && setResult({ compute }),
			(error: Error) => active && setResult({ error: error.message }),
		);
		return () => {
			active = false;
		};
	}, [status, version]);
	return result;
}
