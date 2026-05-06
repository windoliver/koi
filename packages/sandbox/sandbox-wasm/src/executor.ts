import type { Result } from "@koi/core";

import type { WasmCall, WasmError, WasmExecuteOptions, WasmExecutor, WasmResult } from "./types.js";

const WASM_MAGIC = Object.freeze([0x00, 0x61, 0x73, 0x6d]); // \0asm

const fail = (
  code: WasmError["code"],
  message: string,
  startedAtMs: number,
  cause?: unknown,
): Result<WasmResult, WasmError> => ({
  ok: false,
  error: {
    code,
    message,
    durationMs: Date.now() - startedAtMs,
    ...(cause === undefined ? {} : { cause }),
  },
});

const hasWasmMagic = (bytes: Uint8Array): boolean => {
  if (bytes.length < 4) return false;
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== WASM_MAGIC[i]) return false;
  }
  return true;
};

const moduleCache = new Map<string, WebAssembly.Module>();

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", ab);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    const b = view[i] ?? 0;
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
};

/**
 * In-process WASM executor.
 *
 * Compiled modules are cached internally keyed by SHA-256 of validated bytes;
 * cache is package-private and never exposed.
 *
 * Timeout note: WASM exports are synchronous in JS; a `timeoutMs` option is
 * accepted for API parity but cannot preempt a runaway export inside the host
 * isolate. Callers requiring hard preemption must run the executor inside a
 * Worker thread. v1 documents this limitation; a future package may add it.
 */
export const createWasmExecutor = (): WasmExecutor => {
  const execute = async (
    moduleBytes: Uint8Array,
    call: WasmCall,
    options?: WasmExecuteOptions,
  ): Promise<Result<WasmResult, WasmError>> => {
    const startedAtMs = Date.now();

    if (!hasWasmMagic(moduleBytes)) {
      return fail(
        "INVALID_BYTES",
        "input is not a WebAssembly module (missing \\0asm magic)",
        startedAtMs,
      );
    }
    if (!WebAssembly.validate(moduleBytes)) {
      return fail("VALIDATION", "WebAssembly.validate() rejected the module", startedAtMs);
    }

    let mod: WebAssembly.Module;
    const cacheKey = await sha256Hex(moduleBytes);
    const cached = moduleCache.get(cacheKey);
    if (cached !== undefined) {
      mod = cached;
    } else {
      try {
        mod = await WebAssembly.compile(moduleBytes);
      } catch (cause) {
        return fail("VALIDATION", "WebAssembly.compile failed", startedAtMs, cause);
      }
      moduleCache.set(cacheKey, mod);
    }

    let instance: WebAssembly.Instance;
    try {
      // instantiate(Module, imports) overload returns Instance directly.
      // Cast through `never` — `WasmImports` accepts `unknown` per-import for
      // ergonomics, but `WebAssembly.instantiate` requires the runtime's strict
      // `ImportValue` shape. Operator code supplies valid imports; executor does not narrow.
      const importsArg = (options?.imports ?? {}) as never;
      instance = (await WebAssembly.instantiate(
        mod,
        importsArg,
      )) as unknown as WebAssembly.Instance;
    } catch (cause) {
      return fail("INSTANTIATE_FAILED", "WebAssembly.instantiate failed", startedAtMs, cause);
    }

    const exported = (instance.exports as Record<string, unknown>)[call.export];
    if (exported === undefined) {
      return fail("MISSING_EXPORT", `module has no export named "${call.export}"`, startedAtMs);
    }
    if (typeof exported !== "function") {
      return fail("EXPORT_NOT_CALLABLE", `export "${call.export}" is not a function`, startedAtMs);
    }

    const maxPages = options?.maxMemoryPages;
    if (maxPages !== undefined) {
      const memory = (instance.exports as Record<string, unknown>).memory;
      if (memory instanceof WebAssembly.Memory) {
        const pages = memory.buffer.byteLength / 65536;
        if (pages > maxPages) {
          return fail(
            "OOM",
            `module memory ${pages} pages exceeds maxMemoryPages=${maxPages}`,
            startedAtMs,
          );
        }
      }
    }

    try {
      const fn = exported as (...args: readonly unknown[]) => unknown;
      const output = fn(...call.args);
      return {
        ok: true,
        value: { output, durationMs: Date.now() - startedAtMs },
      };
    } catch (cause) {
      return fail("TRAP", "WebAssembly trap during execution", startedAtMs, cause);
    }
  };

  return { execute } as const;
};
