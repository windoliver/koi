import type { Result } from "@koi/core";

import { scanWasmSections } from "./section-scan.js";
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

/**
 * Bounded module cache (process-global). Compiled `WebAssembly.Module`
 * objects hold native memory, so an unbounded cache is a memory-DoS vector
 * for any caller that can submit many distinct modules. Cap eviction is
 * insertion-order — the first key inserted is the first evicted, which is a
 * good-enough approximation of LRU for the steady-state pattern of this
 * package (a small set of recurring modules dominates a long tail of unique
 * ones; the long tail is what we want to evict).
 */
const MODULE_CACHE_MAX_ENTRIES = 64;
const moduleCache = new Map<string, WebAssembly.Module>();
const cacheTouch = (key: string, mod: WebAssembly.Module): void => {
  if (moduleCache.has(key)) {
    moduleCache.delete(key);
    moduleCache.set(key, mod);
    return;
  }
  if (moduleCache.size >= MODULE_CACHE_MAX_ENTRIES) {
    const oldest = moduleCache.keys().next().value;
    if (oldest !== undefined) moduleCache.delete(oldest);
  }
  moduleCache.set(key, mod);
};

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
 * Timeout note: WASM exports are synchronous in JS; this in-process executor
 * cannot preempt a runaway export. `timeoutMs` is honored as ADVISORY: the
 * call still runs to completion, but a post-hoc elapsed-time check surfaces
 * `TIMEOUT` so callers detect overruns. Hard preemption needs a Worker-thread
 * executor (not yet shipped). Untrusted modules should not run on this path.
 */
export const createWasmExecutor = (): WasmExecutor => {
  const execute = async (
    moduleBytes: Uint8Array,
    call: WasmCall,
    options?: WasmExecuteOptions,
  ): Promise<Result<WasmResult, WasmError>> => {
    const startedAtMs = Date.now();

    // `timeoutMs` is ADVISORY for this synchronous executor: the in-process
    // implementation cannot preempt a runaway WASM export. We honor the field
    // as a post-hoc deadline check (after the export returns we compare elapsed
    // time and surface TIMEOUT if exceeded) so callers can detect overruns,
    // but no hard preemption is provided. A future Worker-thread executor will
    // upgrade this to true preemption. Untrusted modules should not run on
    // this executor.
    const advisoryTimeoutMs =
      options?.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : undefined;
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

    // Pre-compilation structural scan — enforces the resource-safety invariants
    // the host page cap can't enforce post-instantiation (internal memory bypass,
    // internal table bypass, missing imported memory when a cap is requested).
    const scan = scanWasmSections(moduleBytes);
    if (!scan.ok) {
      return fail("VALIDATION", `wasm section scan failed: ${scan.error.kind}`, startedAtMs);
    }
    if (scan.value.hasInternalMemory) {
      return fail(
        "VALIDATION",
        "module declares an internal memory section; memory must be imported from the host",
        startedAtMs,
      );
    }
    if (scan.value.hasInternalTable) {
      return fail(
        "VALIDATION",
        "module declares an internal table section; tables must be imported from the host",
        startedAtMs,
      );
    }
    if (options?.maxMemoryPages !== undefined) {
      if (scan.value.importedMemoryCount === 0) {
        return fail(
          "VALIDATION",
          "maxMemoryPages requires the module to import memory from the host",
          startedAtMs,
        );
      }
      const declared = scan.value.importedMemory?.limits;
      if (declared !== undefined && declared.min > options.maxMemoryPages) {
        return fail(
          "OOM",
          `imported memory minimum ${declared.min} pages exceeds maxMemoryPages=${options.maxMemoryPages}`,
          startedAtMs,
        );
      }
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
      cacheTouch(cacheKey, mod);
    }

    // If the module imports memory and the caller didn't already supply that
    // import, create a host-owned `WebAssembly.Memory` sized to the module's
    // declared minimum and capped at `maxMemoryPages`. This is the only way
    // the executor can actually enforce the page cap — the module declares
    // the import, the host owns the buffer.
    let hostMemory: WebAssembly.Memory | undefined;
    const importsBase: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(options?.imports ?? {})) {
      importsBase[k] = { ...v };
    }
    if (scan.value.importedMemory !== undefined) {
      const desc = scan.value.importedMemory;
      const callerNs = importsBase[desc.module];
      const callerProvidedMemory = callerNs !== undefined && callerNs[desc.name] !== undefined;
      const maxPages = options?.maxMemoryPages;
      // When `maxMemoryPages` is set, the executor MUST own the memory object
      // — a caller-supplied `WebAssembly.Memory` could declare a larger
      // `maximum` (or no maximum at all), and the guest could `memory.grow()`
      // past the host's cap during execution. Override any caller-supplied
      // memory with a host-created one whose `maximum` equals the cap.
      const shouldInject = !callerProvidedMemory || maxPages !== undefined;
      if (shouldInject) {
        const initial = desc.limits.min;
        const maximum = maxPages !== undefined ? maxPages : (desc.limits.max ?? undefined);
        try {
          hostMemory =
            maximum !== undefined
              ? new WebAssembly.Memory({ initial, maximum })
              : new WebAssembly.Memory({ initial });
        } catch (cause) {
          return fail("INSTANTIATE_FAILED", "host memory allocation failed", startedAtMs, cause);
        }
        const ns = importsBase[desc.module] ?? {};
        ns[desc.name] = hostMemory;
        importsBase[desc.module] = ns;
      }
    }

    let instance: WebAssembly.Instance;
    try {
      const importsArg = importsBase as never;
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
      // Prefer the host-injected memory (definitive — we own the page cap on
      // its `maximum`). Fall back to the export only when the caller supplied
      // their own memory import, in which case best-effort post-instantiation
      // page-count check is the strongest guarantee available.
      const memory = hostMemory ?? (instance.exports as Record<string, unknown>).memory;
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
      const elapsed = Date.now() - startedAtMs;
      // Advisory deadline check — synchronous executor cannot preempt mid-call,
      // but it can surface TIMEOUT post-hoc so callers detect runaway exports.
      if (advisoryTimeoutMs !== undefined && elapsed > advisoryTimeoutMs) {
        return fail(
          "TIMEOUT",
          `export "${call.export}" took ${elapsed}ms, exceeding advisory timeoutMs=${advisoryTimeoutMs}`,
          startedAtMs,
        );
      }
      return {
        ok: true,
        value: { output, durationMs: elapsed },
      };
    } catch (cause) {
      return fail("TRAP", "WebAssembly trap during execution", startedAtMs, cause);
    }
  };

  return { execute } as const;
};
