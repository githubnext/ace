import { abort, bytes, command, duration, port, preview, SandboxError, sandboxError, sandboxPath, result, unsupported, } from "@sandbox-sdk/core";
import { namedTunnel, validateTunnels } from "./tunnels.js";
export { cloudflareBridge } from "./bridge.js";
const provider = "cloudflare";
const capabilities = (backups) => ({
    environment: true,
    fileStreaming: "native",
    files: true,
    ports: "dynamic",
    processExec: true,
    processSpawn: "separate",
    raw: {
        backup: "configured",
        buckets: "configured",
        git: true,
        interpreter: true,
        pty: true,
        sessions: true,
        tunnels: "dynamic",
        watching: true,
        websocket: true,
    },
    snapshotCreate: backups ? "filesystem" : false,
    snapshotDelete: false,
    snapshotRestore: backups ? "filesystem" : false,
    streaming: "separate",
});
const backupRoots = [
    "/workspace",
    "/home",
    "/tmp",
    "/var/tmp",
    "/app",
];
const validate = (options) => {
    if (options.binding === undefined) {
        throw sandboxError(provider, "Cloudflare binding missing. Pass the Durable Object binding from env.Sandbox to cloudflare().", "configuration");
    }
    if (options.backups !== undefined &&
        typeof options.backups === "object" &&
        options.backups !== null &&
        "gitignore" in options.backups) {
        throw sandboxError(provider, "Cloudflare backups.gitignore is not supported. Use backups.useGitignore.", "configuration");
    }
    validateTunnels(options.tunnel, options.tunnels);
};
const nativeBackups = (backups) => {
    const { useGitignore, ...options } = backups;
    return {
        ...options,
        ...(useGitignore === undefined ? {} : { gitignore: useGitignore }),
    };
};
const validateBackupCwd = (cwd) => {
    if (!cwd.startsWith("/")) {
        throw sandboxError(provider, "Cloudflare backup cwd must be absolute", "configuration");
    }
    if (cwd.includes("\0")) {
        throw sandboxError(provider, "Cloudflare backup cwd must not contain null bytes", "configuration");
    }
    if (cwd.split("/").includes("..")) {
        throw sandboxError(provider, 'Cloudflare backup cwd must not contain ".." path segments', "configuration");
    }
    if (!backupRoots.some((root) => cwd === root || cwd.startsWith(`${root}/`))) {
        throw sandboxError(provider, "Cloudflare backup cwd must be under /workspace, /home, /tmp, /var/tmp, or /app", "configuration");
    }
};
const binary = (content) => Uint8Array.from(atob(content), (char) => char.codePointAt(0) ?? 0);
const base64 = (input) => {
    const chunks = [];
    for (let index = 0; index < input.length; index += 32_768) {
        chunks.push(String.fromCodePoint(...input.subarray(index, index + 32_768)));
    }
    return btoa(chunks.join(""));
};
const readable = (input) => input instanceof ReadableStream;
const write = async (raw, path, input) => {
    if (readable(input)) {
        await raw.writeFile(path, input);
        return;
    }
    const value = await bytes(input);
    if (typeof value === "string") {
        await raw.writeFile(path, value, { encoding: "utf-8" });
        return;
    }
    await raw.writeFile(path, base64(value), { encoding: "base64" });
};
const check = (signal) => {
    if (signal?.aborted) {
        abort(provider, signal.reason);
    }
};
const rejectUnsupported = (feature) => {
    try {
        unsupported(provider, feature);
    }
    catch (error) {
        return Promise.reject(error);
    }
};
const wrap = async (action, feature) => {
    try {
        return await action();
    }
    catch (error) {
        if (error instanceof SandboxError) {
            throw error;
        }
        throw sandboxError(provider, `${feature} failed`, "provider", error);
    }
};
const providerCode = (error) => {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return;
    }
    const { code } = error;
    return typeof code === "string" ? code : undefined;
};
const backupWrap = async (action, feature) => {
    try {
        return await action();
    }
    catch (error) {
        if (error instanceof SandboxError) {
            throw error;
        }
        const code = providerCode(error);
        if (code === "INVALID_BACKUP_CONFIG") {
            throw sandboxError(provider, "Cloudflare backup configuration is invalid. Check BACKUP_BUCKET, production R2 credentials, cwd, and backup options.", "configuration", error);
        }
        if (code === "BACKUP_NOT_FOUND") {
            throw sandboxError(provider, "Cloudflare snapshot not found", "not_found", error);
        }
        throw sandboxError(provider, `${feature} failed`, "provider", error);
    }
};
const validatePort = (value) => {
    const target = port(value, provider);
    if (target >= 1024 && target !== 3000) {
        return target;
    }
    throw sandboxError(provider, "Cloudflare preview ports must be integers from 1024 to 65535, excluding 3000", target === 3000 ? "unsupported" : "configuration");
};
const executeLine = async (raw, cwd, line, options) => {
    check(options.signal);
    const timeout = duration(options.timeout, provider);
    try {
        const output = await raw.exec(line, {
            cwd: options.cwd ?? cwd,
            ...(options.env === undefined ? {} : { env: { ...options.env } }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(timeout === undefined ? {} : { timeout }),
        });
        return result(output.exitCode, output.stdout, output.stderr);
    }
    catch (error) {
        throw sandboxError(provider, "Command failed", "process", error);
    }
};
const execute = (raw, cwd, executable, args, options) => executeLine(raw, cwd, command(executable, args), options);
const wait = async (raw, process) => {
    const output = await process.waitForExit();
    const logs = await raw.getProcessLogs(process.id);
    return result(output.exitCode, logs.stdout, logs.stderr);
};
const encoder = new TextEncoder();
const parseEvent = (block) => {
    let event;
    const data = [];
    for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
            event = line.slice(6).trim();
        }
        if (line.startsWith("data:")) {
            data.push(line.slice(5).trimStart());
        }
    }
    if (data.length === 0) {
        return;
    }
    return event === undefined
        ? { data: data.join("\n") }
        : { data: data.join("\n"), event };
};
const parseLog = (block) => {
    const event = parseEvent(block);
    if (event === undefined) {
        return;
    }
    try {
        const payload = JSON.parse(event.data);
        if ((payload.type === "stdout" || payload.type === "stderr") &&
            typeof payload.data === "string") {
            return {
                channel: payload.type,
                value: encoder.encode(payload.data),
            };
        }
    }
    catch {
        if (event.event === "stdout" || event.event === "stderr") {
            return {
                channel: event.event,
                value: encoder.encode(event.data),
            };
        }
    }
};
const lazy = (factory) => {
    let promise;
    const get = () => {
        promise ??= factory();
        return promise;
    };
    return {
        // oxlint-disable-next-line promise/prefer-await-to-then
        catch: (onrejected) => get().catch(onrejected),
        // oxlint-disable-next-line promise/prefer-await-to-then
        finally: (onfinally) => get().finally(onfinally),
        // oxlint-disable-next-line unicorn/no-thenable promise/prefer-await-to-then promise/prefer-catch
        then: (onfulfilled, onrejected) => get().then(onfulfilled, onrejected),
        [Symbol.toStringTag]: "Promise",
    };
};
const include = (channel, log) => channel === "output" || channel === log.channel;
const logs = (raw, process) => {
    const chunks = [];
    const controllers = {
        output: new Set(),
        stderr: new Set(),
        stdout: new Set(),
    };
    let closed = false;
    let failed;
    let pump;
    const emit = (log) => {
        chunks.push(log);
        for (const channel of ["output", log.channel]) {
            for (const controller of controllers[channel]) {
                controller.enqueue(log.value);
            }
        }
    };
    const close = () => {
        closed = true;
        for (const group of Object.values(controllers)) {
            for (const controller of group) {
                controller.close();
            }
            group.clear();
        }
    };
    const fail = (value) => {
        failed = value;
        for (const group of Object.values(controllers)) {
            for (const controller of group) {
                controller.error(value);
            }
            group.clear();
        }
    };
    const start = () => {
        pump ??= (async () => {
            const output = await raw.streamProcessLogs(process.id);
            const reader = output.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            try {
                while (true) {
                    const next = await reader.read();
                    if (next.done) {
                        break;
                    }
                    buffer += decoder.decode(next.value, { stream: true });
                    const blocks = buffer.split(/\r?\n\r?\n/u);
                    buffer = blocks.pop() ?? "";
                    for (const block of blocks) {
                        const log = parseLog(block);
                        if (log !== undefined) {
                            emit(log);
                        }
                    }
                }
                buffer += decoder.decode();
                if (buffer.trim().length > 0) {
                    const log = parseLog(buffer);
                    if (log !== undefined) {
                        emit(log);
                    }
                }
                close();
            }
            catch (error) {
                fail(error);
            }
            finally {
                reader.releaseLock();
            }
        })();
    };
    const create = (channel) => {
        let active;
        return new ReadableStream({
            cancel() {
                if (active !== undefined) {
                    controllers[channel].delete(active);
                }
            },
            start(controller) {
                active = controller;
                for (const log of chunks) {
                    if (include(channel, log)) {
                        controller.enqueue(log.value);
                    }
                }
                if (failed !== undefined) {
                    controller.error(failed);
                    return;
                }
                if (closed) {
                    controller.close();
                    return;
                }
                controllers[channel].add(controller);
                start();
            },
        });
    };
    return {
        output: create("output"),
        stderr: create("stderr"),
        stdout: create("stdout"),
    };
};
const spawnLine = async (raw, cwd, line, options) => {
    check(options.signal);
    const timeout = duration(options.timeout, provider);
    try {
        const process = await raw.startProcess(line, {
            cwd: options.cwd ?? cwd,
            ...(options.env === undefined ? {} : { env: { ...options.env } }),
            ...(timeout === undefined ? {} : { timeout }),
        });
        const cancel = () => {
            void process.kill("SIGTERM");
        };
        const dispose = () => {
            options.signal?.removeEventListener("abort", cancel);
        };
        if (options.signal?.aborted) {
            cancel();
        }
        else {
            options.signal?.addEventListener("abort", cancel, { once: true });
        }
        const output = logs(raw, process);
        return {
            id: process.id,
            kill: async (signal = "SIGTERM") => {
                dispose();
                await process.kill(signal);
            },
            ...output,
            result: lazy(async () => {
                try {
                    return await wait(raw, process);
                }
                finally {
                    dispose();
                }
            }),
        };
    }
    catch (error) {
        throw sandboxError(provider, "Process spawn failed", "process", error);
    }
};
const spawn = (raw, cwd, executable, args, options) => spawnLine(raw, cwd, command(executable, args), options);
const createSandbox = (raw, cwd, options, support) => {
    const { backups } = options;
    const labels = new Map();
    return {
        capabilities: support,
        cwd,
        files: {
            exists: async (path) => {
                const output = await wrap(() => raw.exists(sandboxPath(cwd, path)), "exists");
                return output.exists;
            },
            list: async (path = cwd) => {
                const target = sandboxPath(cwd, path);
                const entries = await wrap(() => raw.listFiles(target, options.list), "list");
                return entries.files
                    .map((entry) => ({
                    kind: entry.type === "directory" ? "directory" : "file",
                    modified: new Date(entry.modifiedAt),
                    path: entry.absolutePath,
                    size: entry.size,
                }))
                    .toSorted((left, right) => left.path.localeCompare(right.path));
            },
            mkdir: async (path) => {
                await wrap(() => raw.mkdir(sandboxPath(cwd, path), { recursive: true }), "mkdir");
            },
            read: async (path) => {
                const output = await wrap(() => raw.readFile(sandboxPath(cwd, path), { encoding: "base64" }), "read");
                return binary(output.content);
            },
            remove: async (path) => {
                await wrap(() => raw.deleteFile(sandboxPath(cwd, path)), "remove");
            },
            stream: async (path) => {
                const output = await wrap(() => raw.readFile(sandboxPath(cwd, path), { encoding: "none" }), "stream");
                return output.content;
            },
            text: async (path) => {
                const output = await wrap(() => raw.readFile(sandboxPath(cwd, path), { encoding: "utf-8" }), "text");
                return output.content;
            },
            write: (path, input) => wrap(() => write(raw, sandboxPath(cwd, path), input), "write"),
        },
        id: options.id ?? "default",
        ports: {
            expose: async (value, input) => {
                const target = validatePort(value);
                if ((input !== undefined && "host" in input) ||
                    input?.token !== undefined ||
                    (input?.protocol !== undefined && input.protocol !== "https")) {
                    throw sandboxError(provider, "Cloudflare tunnels only support the default HTTPS URL through ports.expose. Use sandbox.raw for provider-specific networking.", "unsupported");
                }
                const output = await wrap(() => raw.tunnels.get(target, namedTunnel(options.tunnel, options.tunnels, target, labels)), "port exposure");
                return preview(output.url, target, { provider });
            },
        },
        process: {
            exec: (executable, args = [], run = {}) => execute(raw, cwd, executable, args, run),
            shell: (script, run = {}) => executeLine(raw, cwd, script, run),
            spawn: (executable, args = [], run = {}) => spawn(raw, cwd, executable, args, run),
            spawnShell: (script, run = {}) => spawnLine(raw, cwd, script, run),
        },
        provider,
        raw,
        snapshots: {
            create: async (name) => {
                if (backups === undefined) {
                    return rejectUnsupported("snapshots");
                }
                const backup = await backupWrap(() => raw.createBackup({
                    ...nativeBackups(backups),
                    dir: cwd,
                    ...(name === undefined ? {} : { name }),
                }), "snapshot create");
                return {
                    id: backup.id,
                    ...(name === undefined || name.length === 0 ? {} : { name }),
                };
            },
            delete: () => rejectUnsupported("snapshots"),
            restore: async (id) => {
                if (backups === undefined) {
                    return rejectUnsupported("snapshots");
                }
                if (id.length === 0) {
                    throw sandboxError(provider, "Cloudflare snapshot id is required for restore", "configuration");
                }
                const restored = await backupWrap(() => raw.restoreBackup({
                    dir: cwd,
                    id,
                    ...(backups.localBucket === true ? { localBucket: true } : {}),
                }), "snapshot restore");
                if (!restored.success) {
                    throw sandboxError(provider, "Cloudflare snapshot restore failed", "provider");
                }
            },
        },
        stop: async () => {
            await wrap(() => raw.destroy(), "stop");
        },
    };
};
/**
 * create a Cloudflare Sandbox adapter from a Worker binding
 *
 * `sandbox.raw` preserves the native Sandbox type from `binding` and defaults to `CloudflareRaw`
 */
export const cloudflare = (options) => {
    const support = capabilities(options.backups !== undefined);
    return {
        capabilities: support,
        async create(input = {}) {
            validate(options);
            const id = input.id ?? options.id ?? crypto.randomUUID();
            const cwd = input.cwd ?? options.cwd ?? "/workspace";
            if (options.backups !== undefined) {
                validateBackupCwd(cwd);
            }
            const { getSandbox } = await import("@cloudflare/sandbox");
            const raw = getSandbox(options.binding, id, {
                enableDefaultSession: false,
                normalizeId: true,
                ...options.options,
                transport: "rpc",
            });
            const env = { ...options.env, ...input.env };
            if (Object.keys(env).length > 0) {
                await raw.setEnvVars(env);
            }
            await raw.mkdir(cwd, { recursive: true });
            return createSandbox(raw, cwd, { ...options, id }, support);
        },
        provider,
    };
};
