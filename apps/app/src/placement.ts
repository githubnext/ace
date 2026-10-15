import type { Listing } from "@ace/host/protocol";

/**
 * Where a channel and its tools run. A cloud channel's listed host only created it: its workspace
 * is a Linux container on the compute service, which has no desktop tools or macOS permissions.
 */
export type Placement =
	| { kind: "local"; host: string }
	| { kind: "hosted"; service: string; workspace: string }
	/** `stopped` while the workspace has no container; a start or stop under way ends it either way. */
	| { kind: "cloud"; service: string; stopped: boolean };

export function placement(channel: Listing): Placement {
	if (!channel.hosted) return { kind: "local", host: channel.host };
	const service = new URL(channel.hosted).host;
	if (channel.compute) {
		return { kind: "cloud", service, stopped: !!channel.stopped && !channel.computing };
	}
	return { kind: "hosted", service, workspace: channel.host };
}
