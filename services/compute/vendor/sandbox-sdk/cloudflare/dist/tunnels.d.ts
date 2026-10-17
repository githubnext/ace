/** named Cloudflare tunnel labels keyed by sandbox port. labels must be unique within one sandbox */
export type CloudflareTunnelNames = Readonly<Record<number, string>>;
export declare const tunnelName: (value: string) => string;
export declare const tunnelPort: (value: number) => number;
export declare const validateTunnels: (tunnel: string | undefined, tunnels: CloudflareTunnelNames | undefined) => void;
export declare const namedTunnel: (tunnel: string | undefined, tunnels: CloudflareTunnelNames | undefined, target: number, labels: Map<string, number>) => Readonly<{
    name: string;
}> | undefined;
//# sourceMappingURL=tunnels.d.ts.map