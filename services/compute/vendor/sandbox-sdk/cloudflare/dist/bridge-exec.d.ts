import type { Entry, Exec, Result } from "@sandbox-sdk/core";
import type { CloudflareBridgeRaw } from "./bridge-client.js";
export declare const rejectUnsupported: (feature: string) => Promise<never>;
export declare const execPayload: (cwd: string, executable: string, args?: readonly string[], options?: Exec) => Record<string, unknown>;
export declare const discard: () => WritableStreamDefaultWriter<Uint8Array>;
export declare const parseExec: (response: Response, writer: WritableStreamDefaultWriter<Uint8Array>) => Promise<Result>;
export declare const run: (raw: CloudflareBridgeRaw, id: string, session: string | undefined, cwd: string, executable: string, args?: readonly string[], options?: Exec) => Promise<Result>;
export declare const mustOk: (value: Result, feature: string) => void;
export declare const list: (raw: CloudflareBridgeRaw, id: string, session: string | undefined, cwd: string, path?: string) => Promise<readonly Entry[]>;
//# sourceMappingURL=bridge-exec.d.ts.map