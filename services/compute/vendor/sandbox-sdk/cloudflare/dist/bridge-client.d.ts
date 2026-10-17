import type { Capabilities, Input } from "@sandbox-sdk/core";
import type { CloudflareTunnelNames } from "./tunnels.js";
/** minimal Fetch API contract accepted by Cloudflare bridge requests */
export type CloudflareBridgeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
/** generic JSON object returned by bridge utility routes */
export type CloudflareBridgeJson = Readonly<Record<string, unknown>>;
/**
 * public tunnel returned by the Cloudflare bridge
 *
 * quick tunnels omit `name`, while named tunnels always include the requested DNS label
 */
export type CloudflareBridgeTunnel = Readonly<{
    /** bridge tunnel id */
    id: string;
    /** port exposed inside the sandbox */
    port: number;
    /** public HTTPS tunnel URL */
    url: string;
    /** public tunnel hostname */
    hostname: string;
    /** ISO timestamp when the bridge created the tunnel */
    createdAt: string;
    /** named tunnel label used for a stable Cloudflare hostname */
    name: string;
}> | Readonly<{
    /** bridge tunnel id */
    id: string;
    /** port exposed inside the sandbox */
    port: number;
    /** public HTTPS tunnel URL */
    url: string;
    /** public tunnel hostname */
    hostname: string;
    /** ISO timestamp when the bridge created the tunnel */
    createdAt: string;
    /** quick tunnels do not have a named DNS label */
    name?: never;
}>;
/** options for creating a Cloudflare bridge tunnel */
export type CloudflareBridgeTunnelOptions = Readonly<{
    /** optional DNS label for a stable named tunnel */
    name?: string;
}>;
/**
 * advanced bridge operations exposed as `sandbox.raw`
 *
 * this is a bridge-specific contract, not the normalized snapshot or process api
 */
export type CloudflareBridgeRaw = Readonly<{
    /** create a bridge-managed sandbox and return its id */
    create(): Promise<Readonly<{
        /** bridge sandbox id */
        id: string;
    }>>;
    /** permanently delete a bridge-managed sandbox */
    delete(id: string): Promise<void>;
    /** fetch implementation used for bridge requests */
    fetch: CloudflareBridgeFetch;
    /** query the bridge health endpoint */
    health(): Promise<CloudflareBridgeJson>;
    /** restore a bridge workspace archive into a sandbox */
    hydrate(id: string, archive: Input): Promise<void>;
    /** mount object storage into a bridge sandbox */
    mount(id: string, input: CloudflareBridgeMount): Promise<void>;
    /** read the bridge OpenAPI document */
    openapi(): Promise<CloudflareBridgeJson>;
    /** bridge prewarm pool controls */
    pool: Readonly<{
        /** prewarm bridge sandbox capacity */
        prime(): Promise<void>;
        /** shut down bridge prewarmed sandboxes */
        shutdownPrewarmed(): Promise<void>;
        /** return bridge prewarm pool statistics */
        stats(): Promise<CloudflareBridgeJson>;
    }>;
    /** export the bridge workspace as a tar archive */
    persist(id: string, options?: CloudflareBridgePersist): Promise<Uint8Array>;
    /** return WebSocket connection details for an interactive terminal */
    pty(id: string, options?: CloudflareBridgePty): CloudflareBridgePtyConnection;
    /** make an authenticated request to an arbitrary bridge route */
    request(path: string, init?: RequestInit): Promise<Response>;
    /** return whether a bridge sandbox is still running */
    running(id: string): Promise<boolean>;
    /** bridge tunnel controls */
    tunnels: Readonly<{
        /**
         * create or return a public HTTPS tunnel for an already-listening sandbox port
         *
         * ports must be integers from 1024 through 65535, excluding 3000. pass `name` only when the bridge Worker is configured for named tunnels
         */
        get(id: string, port: number, options?: CloudflareBridgeTunnelOptions): Promise<CloudflareBridgeTunnel>;
        /** delete a tunnel and its tracked named-tunnel resources when present */
        destroy(id: string, port: number): Promise<void>;
    }>;
    /** bridge execution session controls */
    session: Readonly<{
        /** create an execution session scoped to one sandbox */
        create(id: string, options?: CloudflareBridgeSession): Promise<Readonly<{
            /** bridge execution session id */
            id: string;
        }>>;
        /** delete one execution session */
        delete(id: string, session: string): Promise<void>;
    }>;
    /** detach a mounted object-storage bucket from a sandbox */
    unmount(id: string, mountPath: string): Promise<void>;
    /** configured bridge base URL */
    url: string;
}>;
/** Cloudflare Sandbox bridge adapter configuration */
export type CloudflareBridge = Readonly<{
    /**
     * deployed bridge base URL
     *
     * falls back to `SANDBOX_API_URL`
     *
     * remote bridges must use https, with http supported only for local loopback development
     */
    url?: string;
    /**
     * bearer token for the bridge
     *
     * falls back to `SANDBOX_API_KEY`
     */
    token?: string;
    /**
     * default sandbox working directory below `/workspace`
     *
     * relative values resolve below `/workspace`, custom directories are created, and paths outside it are rejected before bridge work
     *
     * @default "/workspace"
     */
    cwd?: string;
    /**
     * default environment variables for bridge execution sessions
     *
     * create input values override these defaults. values are copied into the bridge sandbox, so pass only values the sandbox may use. `SANDBOX_API_KEY` is rejected because it authenticates the bridge
     */
    env?: Readonly<Record<string, string>>;
    /** custom fetch implementation for tests or non-standard runtimes */
    fetch?: CloudflareBridgeFetch;
    /** stable sandbox id used when create input omits id */
    id?: string;
    /**
     * optional DNS label for normalized named tunnel previews
     *
     * use it for one named tunnel or as the fallback for one port not listed in `tunnels`. named tunnels require the bridge Worker to have Cloudflare account and zone credentials
     */
    tunnel?: string;
    /** named tunnel labels keyed by port. entries override `tunnel` and labels must be unique within one sandbox */
    tunnels?: CloudflareTunnelNames;
}>;
/** connection details for the bridge PTY WebSocket route */
export type CloudflareBridgePtyConnection = Readonly<{
    /** headers to pass when the WebSocket client supports custom headers */
    headers: Readonly<Record<string, string>>;
    /** WebSocket URL for `/v1/sandbox/:id/pty` */
    url: string;
}>;
/** options for `sandbox.raw.persist()` */
export type CloudflareBridgePersist = Readonly<{
    /** workspace-relative paths to exclude from the tar archive */
    excludes?: readonly string[];
}>;
/** options for creating a bridge execution session */
export type CloudflareBridgeSession = Readonly<{
    /** custom session id */
    id?: string;
    /** initial working directory */
    cwd?: string;
    /** session-scoped environment variables */
    env?: Readonly<Record<string, string>>;
}>;
/** options for mounting an object-storage bucket through the bridge */
export type CloudflareBridgeMount = Readonly<{
    /** bucket name or Worker R2 binding name */
    bucket: string;
    /** absolute mount path inside the sandbox */
    mountPath: string;
    /** bridge mount options forwarded to Cloudflare */
    options?: Readonly<Record<string, unknown>>;
}>;
/** options for the raw bridge PTY WebSocket route */
export type CloudflareBridgePty = Readonly<{
    /** terminal width in columns */
    cols?: number;
    /** terminal height in rows */
    rows?: number;
    /** bridge session id used to scope the terminal */
    session?: string;
    /** shell binary to run inside the terminal */
    shell?: string;
}>;
export declare const provider = "cloudflare";
export declare const bridgeCapabilities: Capabilities;
export declare const absolute: (cwd: string, path?: string) => string;
export declare const route: (path: string) => string;
export declare const fail: (response: Response, feature: string) => Promise<never>;
export declare const bridgeBody: (input: Uint8Array | string) => ArrayBuffer | string;
export declare const bridge: (options: CloudflareBridge) => CloudflareBridgeRaw;
//# sourceMappingURL=bridge-client.d.ts.map