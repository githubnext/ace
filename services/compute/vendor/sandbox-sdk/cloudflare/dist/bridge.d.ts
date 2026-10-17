import type { Adapter } from "@sandbox-sdk/core";
import type { CloudflareBridge, CloudflareBridgeRaw } from "./bridge-client.js";
export type { CloudflareBridge, CloudflareBridgeFetch, CloudflareBridgeJson, CloudflareBridgeRaw, CloudflareBridgeMount, CloudflareBridgePersist, CloudflareBridgePty, CloudflareBridgePtyConnection, CloudflareBridgeSession, CloudflareBridgeTunnel, CloudflareBridgeTunnelOptions, } from "./bridge-client.js";
/**
 * create a Cloudflare Sandbox adapter that talks to the official HTTP bridge
 *
 * `ports.expose()` creates an ephemeral HTTPS quick tunnel by default. configure `tunnel` for one named port or `tunnels` for per-port labels when the bridge Worker has the required Cloudflare credentials
 */
export declare const cloudflareBridge: (options?: CloudflareBridge) => Adapter<CloudflareBridgeRaw>;
//# sourceMappingURL=bridge.d.ts.map