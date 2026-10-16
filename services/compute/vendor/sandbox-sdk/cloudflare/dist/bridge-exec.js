import { duration, sandboxError, unsupported } from "@sandbox-sdk/core";
import { absolute, fail, provider } from "./bridge-client.js";
export const rejectUnsupported = (feature) => {
    try {
        unsupported(provider, feature);
    }
    catch (error) {
        return Promise.reject(error);
    }
};
export const execPayload = (cwd, executable, args = [], options = {}) => ({
    argv: options.env === undefined
        ? [executable, ...args]
        : [
            "env",
            ...Object.entries(options.env).map(([key, value]) => `${key}=${value}`),
            executable,
            ...args,
        ],
    cwd: options.cwd === undefined ? cwd : absolute(cwd, options.cwd),
    ...(options.timeout === undefined
        ? {}
        : { timeout_ms: duration(options.timeout, provider) }),
});
const decode = (value) => {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
};
const writeEvent = async (writer, value) => {
    if (value.length > 0) {
        await writer.write(new TextEncoder().encode(value));
    }
};
const parseEvent = (block) => {
    let event = "message";
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
    return { data: data.join("\n"), event };
};
export const discard = () => new WritableStream().getWriter();
const request = (raw, id, session, cwd, executable, args, options) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (session !== undefined) {
        headers.set("session-id", session);
    }
    return raw.request(`/v1/sandbox/${encodeURIComponent(id)}/exec`, {
        body: JSON.stringify(execPayload(cwd, executable, args, options)),
        headers,
        method: "POST",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
};
export const parseExec = async (response, writer) => {
    if (!response.ok) {
        await fail(response, "bridge exec");
    }
    if (response.body === null) {
        throw sandboxError(provider, "Cloudflare bridge exec returned no stream", "provider");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let stdout = "";
    let stderr = "";
    let code = 0;
    const handle = async (block) => {
        const event = parseEvent(block);
        if (event === undefined) {
            return;
        }
        if (event.event === "stdout") {
            const value = decode(event.data);
            stdout += value;
            await writeEvent(writer, value);
        }
        if (event.event === "stderr") {
            const value = decode(event.data);
            stderr += value;
            await writeEvent(writer, value);
        }
        if (event.event === "exit") {
            code = Number(JSON.parse(event.data).exit_code ?? 0);
        }
        if (event.event === "error") {
            const error = JSON.parse(event.data);
            throw sandboxError(provider, `Cloudflare bridge exec failed: ${error.error || "unknown"}`, "process", error);
        }
    };
    while (true) {
        const next = await reader.read();
        if (next.done) {
            break;
        }
        buffer += decoder.decode(next.value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/u);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
            await handle(block);
        }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
        await handle(buffer);
    }
    return { code, ok: code === 0, stderr, stdout };
};
export const run = async (raw, id, session, cwd, executable, args = [], options = {}) => {
    const writer = discard();
    try {
        const result = await parseExec(await request(raw, id, session, cwd, executable, args, options), writer);
        return result;
    }
    finally {
        await writer.close();
    }
};
const listScript = `
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const entries = fs.readdirSync(root, { withFileTypes: true }).map((entry) => {
  const absolute = path.join(root, entry.name);
  const stats = fs.statSync(absolute);
  return {
    path: absolute,
    kind: entry.isDirectory() ? "directory" : "file",
    size: stats.size,
    modified: stats.mtime.toISOString()
  };
});
console.log(JSON.stringify(entries));
`;
export const mustOk = (value, feature) => {
    if (!value.ok) {
        throw sandboxError(provider, `Cloudflare bridge ${feature} failed`, "provider", value);
    }
};
export const list = async (raw, id, session, cwd, path) => {
    const target = absolute(cwd, path);
    const writer = discard();
    try {
        const value = await parseExec(await raw.request(`/v1/sandbox/${encodeURIComponent(id)}/exec`, {
            body: JSON.stringify(execPayload(cwd, "node", ["-e", listScript, target])),
            headers: {
                ...(session === undefined ? {} : { "session-id": session }),
                "content-type": "application/json",
            },
            method: "POST",
        }), writer);
        mustOk(value, "list");
        return JSON.parse(value.stdout).map((entry) => entry.modified === undefined
            ? {
                kind: entry.kind,
                path: entry.path,
                ...(entry.size === undefined ? {} : { size: entry.size }),
            }
            : {
                kind: entry.kind,
                modified: new Date(entry.modified),
                path: entry.path,
                ...(entry.size === undefined ? {} : { size: entry.size }),
            });
    }
    finally {
        await writer.close();
    }
};
