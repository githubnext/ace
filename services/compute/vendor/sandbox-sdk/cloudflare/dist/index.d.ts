import type { BackupOptions, ListFilesOptions, Sandbox as CloudflareSandbox, SandboxOptions } from "@cloudflare/sandbox";
import type { Adapter } from "@sandbox-sdk/core";
import type { CloudflareTunnelNames } from "./tunnels.js";
export { cloudflareBridge } from "./bridge.js";
export type { CloudflareBridge, CloudflareBridgeFetch, CloudflareBridgeJson, CloudflareBridgeMount, CloudflareBridgePersist, CloudflareBridgePty, CloudflareBridgePtyConnection, CloudflareBridgeRaw, CloudflareBridgeSession, CloudflareBridgeTunnel, CloudflareBridgeTunnelOptions, } from "./bridge.js";
export type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
export type { CloudflareTunnelNames } from "./tunnels.js";
type Native = CloudflareSandbox<unknown>;
/** native Cloudflare Sandbox object exposed as `sandbox.raw` for Worker-only features */
export type CloudflareRaw = Native;
/** Cloudflare Worker Durable Object namespace for a native Sandbox class */
export type CloudflareBinding<ProviderRaw extends CloudflareRaw = CloudflareRaw> = DurableObjectNamespace<ProviderRaw>;
/**
 * Cloudflare R2 backup options for normalized filesystem snapshots
 *
 * `dir` is the sandbox cwd and `name` comes from `snapshots.create(name?)`
 * use `useGitignore` to match Cloudflare's public backup documentation
 * configure `BACKUP_BUCKET` and production R2 credentials on the Worker before enabling this
 */
export type CloudflareBackups = Readonly<{
    /** archive compression format and worker count */
    compression?: NonNullable<BackupOptions["compression"]>;
    /** glob patterns excluded from the backup archive */
    excludes?: NonNullable<BackupOptions["excludes"]>;
    /** use the Worker R2 binding directly for local development */
    localBucket?: NonNullable<BackupOptions["localBucket"]>;
    /** use multipart R2 uploads for large archives */
    multipart?: NonNullable<BackupOptions["multipart"]>;
    /** backup lifetime in seconds */
    ttl?: NonNullable<BackupOptions["ttl"]>;
    /** exclude files matched by .gitignore when the backup directory is a git repository */
    useGitignore?: boolean;
}>;
/**
 * Cloudflare Worker-native Sandbox adapter configuration
 *
 * `ProviderRaw` is inferred from `binding`, so `sandbox.raw` keeps the exact native Cloudflare Sandbox environment type
 *
 * use `cloudflareBridge()` for a deployed HTTP bridge outside a Cloudflare Worker
 */
export type Cloudflare<ProviderRaw extends CloudflareRaw = CloudflareRaw> = Readonly<{
    /** required Durable Object binding for the Cloudflare Sandbox class, usually `env.Sandbox` */
    binding: CloudflareBinding<ProviderRaw>;
    /** configured R2 backups that enable normalized filesystem snapshot create and restore */
    backups?: CloudflareBackups;
    /**
     * default working directory for normalized file and process operations
     *
     * @default "/workspace"
     */
    cwd?: string;
    /**
     * default environment variables written to the selected sandbox
     *
     * values cross the Worker-to-sandbox trust boundary. pass only secrets the sandbox may use, and keep host-only credentials behind a Worker proxy
     */
    env?: Readonly<Record<string, string>>;
    /** stable sandbox id used when create input omits id */
    id?: string;
    /** list options forwarded to Cloudflare `listFiles` */
    list?: ListFilesOptions;
    /**
     * optional named tunnel label with lowercase letters, digits, and internal hyphens
     *
     * use it for one named tunnel or as the fallback for one port not listed in `tunnels`. named tunnels require Worker-side API token, account, and zone configuration
     */
    tunnel?: string;
    /** named tunnel labels keyed by port. entries override `tunnel` and labels must be unique within one sandbox */
    tunnels?: CloudflareTunnelNames;
    /**
     * low-level options forwarded to `getSandbox`, with the current RPC transport enforced
     *
     * normalized commands are sessionless by default. set `enableDefaultSession: true` only when native raw operations need shared shell state
     */
    options?: Omit<SandboxOptions, "transport">;
}>;
/**
 * create a Cloudflare Sandbox adapter from a Worker binding
 *
 * `sandbox.raw` preserves the native Sandbox type from `binding` and defaults to `CloudflareRaw`
 */
export declare const cloudflare: <ProviderRaw extends CloudflareRaw = CloudflareRaw>(options: Cloudflare<ProviderRaw>) => Adapter<ProviderRaw>;
//# sourceMappingURL=index.d.ts.map