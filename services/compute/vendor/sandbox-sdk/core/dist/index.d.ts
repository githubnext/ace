import type { Adapter, Capabilities, Capability, CapabilityModes, Cause, Code, Input, Options, Port, Preview, PreviewOptions, RawCapability, Result, Sandbox, SandboxRuntime } from "./types.js";
export type { Adapter, Capabilities, Capability, CapabilityModes, Cause, Code, Entry, Exec, Files, Input, Mode, Options, Port, Ports, Preview, PreviewOptions, Process, RawCapability, Result, Running, Sandbox, SandboxRuntimeFiles, SandboxRuntimeProcess, SandboxRuntimePorts, SandboxRuntimePreview, SandboxRuntime, Snapshot, Snapshots, Spawn, Timer, Url, } from "./types.js";
export { rawCapabilities } from "./types.js";
/**
 * normalized error emitted by public sandbox sdk operations
 *
 * use `code` for portable error handling and `provider` to identify the adapter
 * that raised the error
 */
export declare class SandboxError extends Error {
    /** stable sandbox sdk error code for portable error handling */
    readonly code: Code;
    /** adapter provider name when the failing operation is provider-specific */
    readonly provider?: string;
    /** create a normalized error from an adapter or public helper */
    constructor(message: string, options: Cause & {
        code: Code;
        provider?: string;
    });
}
/**
 * return whether a value is a normalized sandbox sdk error
 *
 * use this instead of matching provider-specific error messages when handling
 * errors from multiple adapters
 */
export declare const isSandboxError: (error: unknown) => error is SandboxError;
/**
 * create a sandbox through an adapter
 *
 * adapter configuration stays on the adapter and per-sandbox options stay in
 * `input`, keeping provider setup separate from a single sandbox request
 */
export declare const create: <Raw = unknown>(input: Options & {
    adapter: Adapter<Raw>;
}) => Promise<Sandbox<Raw>>;
/**
 * create a sandbox, run work, and always attempt cleanup
 *
 * use this for short-lived work where retaining the sandbox after the callback
 * completes would be unexpected
 * consume streams and finish background work inside the callback
 * returning a stream or process handle does not extend the sandbox lifetime
 *
 * @example
 * import { withSandbox } from "@sandbox-sdk/core"
 * import { local } from "@sandbox-sdk/local"
 *
 * const result = await withSandbox({ adapter: local() }, (sandbox) =>
 *   sandbox.process.shell("printf hello")
 * )
 */
export declare const withSandbox: <Raw = unknown, Output = unknown>(input: Options & {
    adapter: Adapter<Raw>;
}, use: (sandbox: Sandbox<Raw>) => Output | Promise<Output>) => Promise<Output>;
/** return the advertised mode for a capability or undefined when absent */
export declare const capabilityMode: <Key extends Capability>(subject: {
    capabilities: Capabilities;
}, capability: Key) => Exclude<CapabilityModes[Key], false | undefined> | undefined;
/** throw a normalized unsupported feature error */
export declare const unsupported: (provider: string, feature: string) => never;
/** require a capability and throw a typed unsupported error when missing */
export declare const requireCapability: <Key extends Capability>(subject: {
    capabilities: Capabilities;
    provider?: string;
}, capability: Key) => Exclude<CapabilityModes[Key], false | undefined>;
/** true when a subject advertises a capability */
export declare const supports: <Key extends Capability>(subject: {
    capabilities: Capabilities;
}, capability: Key) => boolean;
/** return the advertised mode for a provider-specific raw capability */
export declare const rawCapabilityMode: <Key extends RawCapability>(subject: {
    capabilities: Capabilities;
}, capability: Key) => Exclude<NonNullable<Capabilities["raw"]>[Key], false | undefined> | undefined;
/** require a provider-specific raw capability and throw when missing */
export declare const requireRawCapability: <Key extends RawCapability>(subject: {
    capabilities: Capabilities;
    provider?: string;
}, capability: Key) => Exclude<NonNullable<Capabilities["raw"]>[Key], false | undefined>;
/** true when a provider-specific feature is available through `sandbox.raw` */
export declare const supportsRaw: <Key extends RawCapability>(subject: {
    capabilities: Capabilities;
}, capability: Key) => boolean;
/** validate and return a normalized tcp port number */
export declare const port: (value: number, provider?: string) => number;
/**
 * create a provider-aware preview with access headers kept out of serializable data
 *
 * adapter authors pass provider-required request headers here instead of placing credentials in the returned url. requests are limited to the preview origin and handle redirects manually
 */
export declare const preview: (url: string, value: number, options?: PreviewOptions) => Preview;
/**
 * validate options against an adapter's provider-derived preview URL
 *
 * call this before provider work when URL tokens or a chosen protocol are unavailable. custom domains stay on adapter-specific configuration or `sandbox.raw`
 */
export declare const portOptions: (provider: string, options: Port | undefined, protocol?: "http" | "https") => void;
/** validate and return a normalized millisecond duration */
export declare const duration: (value?: number, provider?: string, name?: string) => number | undefined;
/** create a normalized provider error */
export declare const sandboxError: (provider: string, message: string, code?: Code, cause?: unknown) => SandboxError;
/** throw a normalized aborted error for an adapter operation */
export declare const abort: (provider: string, cause?: unknown) => never;
/**
 * normalize supported file input into text or bytes
 *
 * passing a readable stream consumes it exactly once
 */
export declare const bytes: (input: Input) => Promise<Uint8Array | string>;
/**
 * decode supported file input as utf-8 text
 *
 * passing a readable stream consumes it exactly once
 */
export declare const text: (input: Input) => Promise<string>;
/** resolve a POSIX sandbox path against cwd without interpreting filenames as URLs */
export declare const sandboxPath: (cwd: string, value?: string) => string;
/**
 * lift a stream-first provider runtime into the public sandbox api
 *
 * adapter authors implement this lower-level contract to preserve streaming
 * for large files and processes while callers receive the normalized api
 */
export declare const fromSandboxRuntime: <Raw = unknown>(input: SandboxRuntime<Raw>) => Sandbox<Raw>;
/** build a normalized command result */
export declare const result: (code: number, stdout?: string, stderr?: string, signal?: string) => Result;
/** quote one shell argument for POSIX shell execution */
export declare const quote: (value: string) => string;
/** build a shell command string from argv parts */
export declare const command: (value: string, args?: readonly string[]) => string;
/** create an abort signal that fires when timeout or parent signal fires */
export declare const timeout: (value?: number, signal?: AbortSignal, provider?: string) => {
    aborted(): boolean;
    clear(): void;
    signal?: AbortSignal;
};
//# sourceMappingURL=index.d.ts.map