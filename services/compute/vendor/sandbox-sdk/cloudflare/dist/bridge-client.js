import { bytes, sandboxError } from "@sandbox-sdk/core";
import { tunnelName, tunnelPort, validateTunnels } from "./tunnels.js";
export const provider = "cloudflare";
export const bridgeCapabilities = {
    environment: "separate",
    fileStreaming: "native",
    files: true,
    ports: "dynamic",
    processExec: true,
    processSpawn: false,
    raw: {
        backup: true,
        buckets: "configured",
        lifecycle: "dynamic",
        pty: true,
        sessions: true,
        tunnels: "dynamic",
    },
    snapshotCreate: false,
    snapshotDelete: false,
    snapshotRestore: false,
    streaming: "separate",
};
export const absolute = (cwd, path = cwd) => {
    const value = path.startsWith("/") ? path : `${cwd}/${path}`;
    const output = new URL(value, "file:///").pathname.replace(/\/+$/u, "") || "/";
    if (output !== "/workspace" && !output.startsWith("/workspace/")) {
        throw sandboxError(provider, "Cloudflare bridge paths must stay under /workspace", "path_escape");
    }
    return output;
};
export const route = (path) => path.replace(/^\/+/u, "").split("/").map(encodeURIComponent).join("/");
export const fail = async (response, feature) => {
    const body = await response.text();
    let error;
    try {
        error = JSON.parse(body);
    }
    catch {
        error = { error: body };
    }
    throw sandboxError(provider, `${feature} failed: ${error.error || response.statusText}`, response.status === 404 ? "not_found" : "provider", error);
};
const env = (name) => globalThis.process?.env?.[name]?.trim() || undefined;
const trim = (value) => value.replace(/\/+$/u, "");
const loopback = (url) => url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
export const bridgeBody = (input) => typeof input === "string" ? input : Uint8Array.from(input).buffer;
const bridgeUrl = (value) => {
    let url;
    try {
        url = new URL(trim(value));
    }
    catch {
        throw sandboxError(provider, "Cloudflare bridge URL must be a valid http or https URL", "configuration");
    }
    if (url.username || url.password || url.search || url.hash) {
        throw sandboxError(provider, "Cloudflare bridge URL must not include credentials, a query, or a fragment", "configuration");
    }
    if (url.protocol === "https:" ||
        (url.protocol === "http:" && loopback(url))) {
        return trim(url.toString());
    }
    throw sandboxError(provider, "Cloudflare bridge URL must use HTTPS outside local loopback development", "configuration");
};
const ptyNumber = (name, value) => {
    if (value === undefined) {
        return;
    }
    if (Number.isInteger(value) && value > 0) {
        return String(value);
    }
    throw sandboxError(provider, `Cloudflare bridge pty ${name} must be a positive integer`, "configuration");
};
const validate = (options) => {
    const url = options.url?.trim() || env("SANDBOX_API_URL");
    if (url === undefined) {
        throw sandboxError(provider, "Cloudflare bridge URL missing. Pass url to cloudflareBridge() or set SANDBOX_API_URL.", "configuration");
    }
    const token = options.token?.trim() || env("SANDBOX_API_KEY");
    validateTunnels(options.tunnel, options.tunnels);
    const value = bridgeUrl(url);
    return token === undefined ? { url: value } : { token, url: value };
};
const pty = (url, token, id, options = {}) => {
    const target = new URL(`${url}/v1/sandbox/${encodeURIComponent(id)}/pty`);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const cols = ptyNumber("cols", options.cols);
    if (cols !== undefined) {
        target.searchParams.set("cols", cols);
    }
    const rows = ptyNumber("rows", options.rows);
    if (rows !== undefined) {
        target.searchParams.set("rows", rows);
    }
    if (options.shell !== undefined) {
        target.searchParams.set("shell", options.shell);
    }
    if (options.session !== undefined) {
        target.searchParams.set("session", options.session);
    }
    return {
        headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
        url: target.toString(),
    };
};
const parseJson = async (response) => {
    try {
        return (await response.json());
    }
    catch (error) {
        throw sandboxError(provider, "Cloudflare bridge returned invalid JSON", "provider", error);
    }
};
const bridgeRequest = (url, token, bridgeFetch, path, init = {}) => {
    const headers = new Headers(init.headers);
    if (token !== undefined) {
        headers.set("authorization", `Bearer ${token}`);
    }
    return bridgeFetch(`${url}${path}`, {
        ...init,
        headers,
        redirect: "error",
    });
};
export const bridge = (options) => {
    const { token, url } = validate(options);
    const bridgeFetch = options.fetch ?? fetch;
    const request = (path, init) => bridgeRequest(url, token, bridgeFetch, path, init);
    return {
        create: async () => {
            const response = await request("/v1/sandbox", { method: "POST" });
            if (!response.ok) {
                await fail(response, "bridge create");
            }
            return parseJson(response);
        },
        delete: async (id) => {
            const response = await request(`/v1/sandbox/${encodeURIComponent(id)}`, {
                method: "DELETE",
            });
            if (!response.ok && response.status !== 404) {
                await fail(response, "bridge delete");
            }
        },
        fetch: bridgeFetch,
        health: async () => {
            const response = await request("/health");
            if (!response.ok) {
                await fail(response, "bridge health");
            }
            return parseJson(response);
        },
        hydrate: async (id, archive) => {
            const input = await bytes(archive);
            const response = await request(`/v1/sandbox/${encodeURIComponent(id)}/hydrate`, {
                body: bridgeBody(input),
                method: "POST",
            });
            if (!response.ok) {
                await fail(response, "bridge hydrate");
            }
        },
        mount: async (id, input) => {
            const response = await request(`/v1/sandbox/${encodeURIComponent(id)}/mount`, {
                body: JSON.stringify(input),
                headers: { "content-type": "application/json" },
                method: "POST",
            });
            if (!response.ok) {
                await fail(response, "bridge mount");
            }
        },
        openapi: async () => {
            const response = await request("/v1/openapi.json");
            if (!response.ok) {
                await fail(response, "bridge openapi");
            }
            return parseJson(response);
        },
        persist: async (id, input) => {
            const search = new URLSearchParams();
            if (input?.excludes !== undefined) {
                search.set("excludes", input.excludes.join(","));
            }
            const suffix = search.size > 0 ? `?${search}` : "";
            const response = await request(`/v1/sandbox/${encodeURIComponent(id)}/persist${suffix}`, { method: "POST" });
            if (!response.ok) {
                await fail(response, "bridge persist");
            }
            return new Uint8Array(await response.arrayBuffer());
        },
        pool: {
            prime: async () => {
                const response = await request("/v1/pool/prime", { method: "POST" });
                if (!response.ok) {
                    await fail(response, "bridge pool prime");
                }
            },
            shutdownPrewarmed: async () => {
                const response = await request("/v1/pool/shutdown-prewarmed", {
                    method: "POST",
                });
                if (!response.ok) {
                    await fail(response, "bridge pool shutdown");
                }
            },
            stats: async () => {
                const response = await request("/v1/pool/stats");
                if (!response.ok) {
                    await fail(response, "bridge pool stats");
                }
                return parseJson(response);
            },
        },
        pty: (id, input) => pty(url, token, id, input),
        request,
        running: async (id) => {
            const response = await request(`/v1/sandbox/${encodeURIComponent(id)}/running`);
            if (!response.ok) {
                await fail(response, "bridge running");
            }
            const payload = await parseJson(response);
            return payload.running;
        },
        session: {
            create: async (id, input = {}) => {
                const response = await request(`/v1/sandbox/${encodeURIComponent(id)}/session`, {
                    body: JSON.stringify(input),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                });
                if (!response.ok) {
                    await fail(response, "bridge session create");
                }
                return parseJson(response);
            },
            delete: async (id, session) => {
                const response = await request(`/v1/sandbox/${encodeURIComponent(id)}/session/${encodeURIComponent(session)}`, { method: "DELETE" });
                if (!response.ok && response.status !== 404) {
                    await fail(response, "bridge session delete");
                }
            },
        },
        tunnels: {
            destroy: async (id, value) => {
                const target = tunnelPort(value);
                const response = await request(`/v1/sandbox/${encodeURIComponent(id)}/tunnel/${target}`, { method: "DELETE" });
                if (!response.ok && response.status !== 404) {
                    await fail(response, "bridge tunnel delete");
                }
            },
            get: async (id, value, input = {}) => {
                const target = tunnelPort(value);
                const name = input.name === undefined ? undefined : tunnelName(input.name);
                const response = await request(`/v1/sandbox/${encodeURIComponent(id)}/tunnel/${target}`, name === undefined
                    ? { method: "POST" }
                    : {
                        body: JSON.stringify({ name }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    });
                if (!response.ok) {
                    await fail(response, "bridge tunnel create");
                }
                return parseJson(response);
            },
        },
        unmount: async (id, mountPath) => {
            const response = await request(`/v1/sandbox/${encodeURIComponent(id)}/unmount`, {
                body: JSON.stringify({ mountPath }),
                headers: { "content-type": "application/json" },
                method: "POST",
            });
            if (!response.ok) {
                await fail(response, "bridge unmount");
            }
        },
        url,
    };
};
