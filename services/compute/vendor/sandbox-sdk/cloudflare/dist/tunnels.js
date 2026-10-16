import { port, sandboxError } from "@sandbox-sdk/core";
const provider = "cloudflare";
const pattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
export const tunnelName = (value) => {
    if (pattern.test(value)) {
        return value;
    }
    throw sandboxError(provider, "Cloudflare named tunnel labels must use 1 to 63 lowercase letters, digits, and internal hyphens", "configuration");
};
export const tunnelPort = (value) => {
    const target = port(value, provider);
    if (target >= 1024 && target !== 3000) {
        return target;
    }
    throw sandboxError(provider, "Cloudflare tunnel ports must be integers from 1024 to 65535, excluding 3000", target === 3000 ? "unsupported" : "configuration");
};
const mappedPort = (value) => {
    const target = tunnelPort(Number(value));
    if (String(target) === value) {
        return target;
    }
    throw sandboxError(provider, "Cloudflare named tunnel ports must use canonical integer keys", "configuration");
};
const collision = (name, current, next) => {
    throw sandboxError(provider, `Cloudflare named tunnel ${name} is already assigned to port ${current}. Configure a distinct label for port ${next}.`, "configuration");
};
export const validateTunnels = (tunnel, tunnels) => {
    if (tunnel !== undefined) {
        tunnelName(tunnel);
    }
    const labels = new Map();
    for (const [value, name] of Object.entries(tunnels ?? {})) {
        const target = mappedPort(value);
        const label = tunnelName(name);
        const current = labels.get(label);
        if (current !== undefined && current !== target) {
            collision(label, current, target);
        }
        labels.set(label, target);
    }
};
export const namedTunnel = (tunnel, tunnels, target, labels) => {
    const name = tunnels?.[target] ?? tunnel;
    if (name === undefined) {
        return;
    }
    const current = labels.get(name);
    if (current !== undefined && current !== target) {
        collision(name, current, target);
    }
    labels.set(name, target);
    return { name };
};
