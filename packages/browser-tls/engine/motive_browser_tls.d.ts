/* tslint:disable */
/* eslint-disable */

export class BrowserTls {
    free(): void;
    [Symbol.dispose](): void;
    close(): void;
    closed(): boolean;
    constructor(host: string);
    outgoing(): Uint8Array;
    plaintext(): Uint8Array;
    /**
     * True only after peer authentication and the required HTTP/1.1 ALPN negotiation.
     */
    ready(): boolean;
    /**
     * Consume part of a TLS input frame. The caller must retain the unread suffix and
     * drain plaintext between calls: rustls bounds both its TLS and plaintext buffers.
     */
    receive(bytes: Uint8Array): number;
    /**
     * There is no way to submit application plaintext before peer authentication succeeds.
     */
    write(plaintext: Uint8Array): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_browsertls_free: (a: number, b: number) => void;
    readonly browsertls_close: (a: number) => void;
    readonly browsertls_closed: (a: number) => number;
    readonly browsertls_new: (a: number, b: number, c: number) => void;
    readonly browsertls_outgoing: (a: number, b: number) => void;
    readonly browsertls_plaintext: (a: number, b: number) => void;
    readonly browsertls_ready: (a: number) => number;
    readonly browsertls_receive: (a: number, b: number, c: number, d: number) => void;
    readonly browsertls_write: (a: number, b: number, c: number, d: number) => void;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
