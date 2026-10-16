export { rawCapabilities } from "./types.js";
/**
 * normalized error emitted by public sandbox sdk operations
 *
 * use `code` for portable error handling and `provider` to identify the adapter
 * that raised the error
 */
export class SandboxError extends Error {
    /** stable sandbox sdk error code for portable error handling */
    code;
    /** adapter provider name when the failing operation is provider-specific */
    provider;
    /** create a normalized error from an adapter or public helper */
    constructor(message, options) {
        super(message, { cause: options.cause });
        this.name = "SandboxError";
        this.code = options.code;
        if (options.provider !== undefined) {
            this.provider = options.provider;
        }
    }
}
/**
 * return whether a value is a normalized sandbox sdk error
 *
 * use this instead of matching provider-specific error messages when handling
 * errors from multiple adapters
 */
export const isSandboxError = (error) => error instanceof SandboxError;
/**
 * create a sandbox through an adapter
 *
 * adapter configuration stays on the adapter and per-sandbox options stay in
 * `input`, keeping provider setup separate from a single sandbox request
 */
export const create = (input) => {
    const { adapter, ...options } = input;
    return adapter.create(options);
};
const stopAfterError = async (sandbox, cause) => {
    try {
        await sandbox.stop();
    }
    catch (error) {
        const failure = new AggregateError([cause, error], "Sandbox use and cleanup failed");
        throw Object.assign(failure, { cause: error });
    }
};
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
export const withSandbox = async (input, use) => {
    const sandbox = await create(input);
    let value;
    try {
        value = await use(sandbox);
    }
    catch (error) {
        await stopAfterError(sandbox, error);
        throw error;
    }
    await sandbox.stop();
    return value;
};
const available = (value) => {
    if (value === undefined || value === false) {
        return undefined;
    }
    return value;
};
/** return the advertised mode for a capability or undefined when absent */
export const capabilityMode = (subject, capability) => available(subject.capabilities[capability]);
/** throw a normalized unsupported feature error */
export const unsupported = (provider, feature) => {
    throw new SandboxError(`${provider} does not support ${feature}`, {
        code: "unsupported",
        provider,
    });
};
/** require a capability and throw a typed unsupported error when missing */
export const requireCapability = (subject, capability) => {
    const value = capabilityMode(subject, capability);
    if (value !== undefined) {
        return value;
    }
    return unsupported(subject.provider ?? "sandbox", capability);
};
/** true when a subject advertises a capability */
export const supports = (subject, capability) => capabilityMode(subject, capability) !== undefined;
/** return the advertised mode for a provider-specific raw capability */
export const rawCapabilityMode = (subject, capability) => available(subject.capabilities.raw?.[capability]);
/** require a provider-specific raw capability and throw when missing */
export const requireRawCapability = (subject, capability) => {
    const value = rawCapabilityMode(subject, capability);
    if (value !== undefined) {
        return value;
    }
    return unsupported(subject.provider ?? "sandbox", `raw ${capability}`);
};
/** true when a provider-specific feature is available through `sandbox.raw` */
export const supportsRaw = (subject, capability) => rawCapabilityMode(subject, capability) !== undefined;
/** validate and return a normalized tcp port number */
export const port = (value, provider = "sandbox") => {
    if (Number.isInteger(value) && value >= 1 && value <= 65_535) {
        return value;
    }
    throw new SandboxError("Port must be an integer from 1 to 65535", {
        code: "configuration",
        provider,
    });
};
/**
 * create a provider-aware preview with access headers kept out of serializable data
 *
 * adapter authors pass provider-required request headers here instead of placing credentials in the returned url. requests are limited to the preview origin and handle redirects manually
 */
export const preview = (url, value, options = {}) => {
    const provider = options.provider ?? "sandbox";
    const targetPort = port(value, provider);
    let base;
    try {
        base = new URL(url);
    }
    catch (error) {
        throw new SandboxError("Preview URL is invalid", {
            cause: error,
            code: "provider",
            provider,
        });
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
        throw new SandboxError("Preview URL must use HTTP or HTTPS", {
            code: "provider",
            provider,
        });
    }
    const configured = new Headers(options.headers);
    const request = (path, init) => {
        let target;
        try {
            target = path === undefined ? new URL(base) : new URL(path, base);
        }
        catch (error) {
            return Promise.reject(new SandboxError("Preview request URL is invalid", {
                cause: error,
                code: "configuration",
                provider,
            }));
        }
        if (target.origin !== base.origin) {
            return Promise.reject(new SandboxError("Preview requests must stay on the preview origin", {
                code: "configuration",
                provider,
            }));
        }
        if (init?.redirect === "follow") {
            return Promise.reject(new SandboxError("Preview requests cannot follow redirects because provider credentials may be attached", {
                code: "configuration",
                provider,
            }));
        }
        for (const [name] of base.searchParams) {
            target.searchParams.delete(name);
        }
        for (const [name, entry] of base.searchParams) {
            target.searchParams.append(name, entry);
        }
        const headers = new Headers(init?.headers);
        for (const [name, entry] of configured) {
            headers.set(name, entry);
        }
        return fetch(target, {
            ...init,
            headers,
            redirect: init?.redirect ?? "manual",
        });
    };
    const output = { port: targetPort, request, url };
    Object.defineProperty(output, "request", {
        enumerable: false,
        value: request,
    });
    return Object.freeze(output);
};
/**
 * validate options against an adapter's provider-derived preview URL
 *
 * call this before provider work when URL tokens or a chosen protocol are unavailable. custom domains stay on adapter-specific configuration or `sandbox.raw`
 */
export const portOptions = (provider, options, protocol) => {
    if (options !== undefined && "host" in options) {
        unsupported(provider, "custom preview hosts");
    }
    if (options?.token !== undefined) {
        unsupported(provider, "preview URL tokens");
    }
    if (protocol !== undefined &&
        options?.protocol !== undefined &&
        options.protocol !== protocol) {
        unsupported(provider, `${options.protocol} preview URLs`);
    }
};
/** validate and return a normalized millisecond duration */
export const duration = (value, provider = "sandbox", name = "timeout") => {
    if (value === undefined) {
        return undefined;
    }
    if (Number.isInteger(value) && value >= 0) {
        return value;
    }
    throw new SandboxError(`${name} must be a non-negative integer`, {
        code: "configuration",
        provider,
    });
};
/** create a normalized provider error */
export const sandboxError = (provider, message, code = "provider", cause) => new SandboxError(message, {
    cause,
    code,
    provider,
});
/** throw a normalized aborted error for an adapter operation */
export const abort = (provider, cause) => {
    throw sandboxError(provider, "Operation aborted", "aborted", cause);
};
/**
 * normalize supported file input into text or bytes
 *
 * passing a readable stream consumes it exactly once
 */
export const bytes = async (input) => {
    if (typeof input === "string" || input instanceof Uint8Array) {
        return input;
    }
    if (input instanceof ArrayBuffer) {
        return new Uint8Array(input);
    }
    if (input instanceof Blob) {
        return new Uint8Array(await input.arrayBuffer());
    }
    const chunks = [];
    const reader = input.getReader();
    while (true) {
        const next = await reader.read();
        if (next.done) {
            break;
        }
        chunks.push(next.value);
    }
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
};
/**
 * decode supported file input as utf-8 text
 *
 * passing a readable stream consumes it exactly once
 */
export const text = async (input) => {
    const value = await bytes(input);
    return typeof value === "string" ? value : new TextDecoder().decode(value);
};
/** resolve a POSIX sandbox path against cwd without interpreting filenames as URLs */
export const sandboxPath = (cwd, value) => {
    const input = value === undefined || value.length === 0 ? cwd : value;
    const path = input.startsWith("/") ? input : `${cwd}/${input}`;
    const parts = [];
    for (const part of path.split("/")) {
        if (part === "..") {
            parts.pop();
        }
        else if (part !== "" && part !== ".") {
            parts.push(part);
        }
    }
    const suffix = path.endsWith("/") && parts.length > 0 ? "/" : "";
    return `/${parts.join("/")}${suffix}`;
};
const read = async (value) => {
    const output = await bytes(value);
    return typeof output === "string" ? new TextEncoder().encode(output) : output;
};
const normalize = async (provider, feature, operation) => {
    try {
        return await operation();
    }
    catch (error) {
        if (isSandboxError(error)) {
            throw error;
        }
        throw sandboxError(provider, `${feature} failed`, "provider", error);
    }
};
const ensure = (sandbox, capability, feature) => {
    if (!supports(sandbox, capability)) {
        unsupported(sandbox.provider, feature);
    }
};
const settle = async (running) => {
    const [output, value] = await Promise.all([
        text(running.output),
        running.result,
    ]);
    return value.stdout.length > 0 || value.stderr.length > 0
        ? value
        : { ...value, stdout: output };
};
const guarded = (input, capability, feature, operation) => {
    try {
        ensure(input, capability, feature);
        return normalize(input.provider, feature, operation);
    }
    catch (error) {
        return Promise.reject(error);
    }
};
const missingRuntime = (provider, feature) => {
    throw sandboxError(provider, `SandboxRuntime ${feature} implementation missing for its advertised capability`, "configuration");
};
/**
 * lift a stream-first provider runtime into the public sandbox api
 *
 * adapter authors implement this lower-level contract to preserve streaming
 * for large files and processes while callers receive the normalized api
 */
export const fromSandboxRuntime = (input) => ({
    capabilities: input.capabilities,
    cwd: input.cwd,
    files: {
        exists: (path) => guarded(input, "files", "files.exists", () => input.files.exists(path)),
        list: (path) => guarded(input, "files", "files.list", () => input.files.list(path)),
        mkdir: (path) => guarded(input, "files", "files.mkdir", () => input.files.mkdir(path)),
        read: (path) => guarded(input, "files", "files.read", async () => read(await input.files.read(path))),
        remove: (path) => guarded(input, "files", "files.remove", () => input.files.remove(path)),
        stream: (path) => guarded(input, "files", "files.stream", () => input.files.read(path)),
        text: (path) => guarded(input, "files", "files.text", async () => text(await read(await input.files.read(path)))),
        write: (path, value) => guarded(input, "files", "files.write", () => input.files.write(path, value)),
    },
    id: input.id,
    ports: {
        expose: async (value, options) => {
            const exposed = await guarded(input, "ports", "ports.expose", () => input.ports.expose(port(value, input.provider), options));
            return preview(exposed.url, exposed.port, {
                ...(exposed.headers === undefined ? {} : { headers: exposed.headers }),
                provider: input.provider,
            });
        },
    },
    process: {
        exec: (executable, args, options) => guarded(input, "processExec", "process.exec", async () => {
            if (input.process.exec !== undefined) {
                return input.process.exec(executable, args, options);
            }
            if (input.process.spawn !== undefined) {
                return settle(await input.process.spawn(executable, args, options));
            }
            return missingRuntime(input.provider, "process.exec");
        }),
        shell: (command, options) => guarded(input, "processExec", "process.shell", async () => {
            if (input.process.shell !== undefined) {
                return input.process.shell(command, options);
            }
            if (input.process.spawnShell !== undefined) {
                return settle(await input.process.spawnShell(command, options));
            }
            return missingRuntime(input.provider, "process.shell");
        }),
        spawn: (executable, args, options) => guarded(input, "processSpawn", "process.spawn", () => {
            if (input.process.spawn === undefined) {
                return missingRuntime(input.provider, "process.spawn");
            }
            return input.process.spawn(executable, args, options);
        }),
        spawnShell: (command, options) => guarded(input, "processSpawn", "process.spawnShell", () => {
            if (input.process.spawnShell === undefined) {
                return missingRuntime(input.provider, "process.spawnShell");
            }
            return input.process.spawnShell(command, options);
        }),
    },
    provider: input.provider,
    raw: input.raw,
    snapshots: {
        create: (name) => guarded(input, "snapshotCreate", "snapshots.create", () => input.snapshots.create(name)),
        delete: (id) => guarded(input, "snapshotDelete", "snapshots.delete", () => input.snapshots.delete(id)),
        restore: (id) => guarded(input, "snapshotRestore", "snapshots.restore", () => input.snapshots.restore(id)),
    },
    status: () => guarded(input, "status", "status", () => {
        if (input.status === undefined) {
            return missingRuntime(input.provider, "status");
        }
        return input.status();
    }),
    stop: input.stop,
});
/** build a normalized command result */
export const result = (code, stdout = "", stderr = "", signal) => ({
    code,
    ok: code === 0,
    ...(signal === undefined ? {} : { signal }),
    stderr,
    stdout,
});
/** quote one shell argument for POSIX shell execution */
export const quote = (value) => {
    if (/^[\w./:@%+=,-]+$/u.test(value)) {
        return value;
    }
    return `'${value.replaceAll("'", "'\\''")}'`;
};
/** build a shell command string from argv parts */
export const command = (value, args = []) => [value, ...args].map(quote).join(" ");
const noop = () => void 0;
/** create an abort signal that fires when timeout or parent signal fires */
export const timeout = (value, signal, provider = "sandbox") => {
    const delay = duration(value, provider);
    if (delay === undefined) {
        return signal === undefined
            ? { aborted: () => false, clear: noop }
            : { aborted: () => signal.aborted, clear: noop, signal };
    }
    let aborted = false;
    const controller = new AbortController();
    const cancel = () => {
        aborted = false;
        controller.abort(signal?.reason);
    };
    const timer = setTimeout(() => {
        aborted = true;
        controller.abort();
    }, delay);
    if (signal?.aborted) {
        cancel();
    }
    else {
        signal?.addEventListener("abort", cancel, { once: true });
    }
    return {
        aborted: () => aborted,
        clear: () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
        },
        signal: controller.signal,
    };
};
