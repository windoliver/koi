/**
 * Built-in promoted-tier executor — runs code in-process.
 *
 * No isolation — promoted tier runs with full process privileges.
 * Security gate is HITL approval in @koi/forge, not the executor.
 *
 * Two execution modes:
 * - **import()**: When `context.entryPath` is provided (brick has npm dependencies),
 *   uses dynamic `import()` with query-string cache busting for in-process execution.
 * - **new Function()**: Fallback for bricks without dependencies (existing behavior).
 *
 * Uses an LRU cache (256-entry cap) keyed by code/path to avoid repeated parsing.
 */

import type { ExecutionContext, SandboxError, SandboxExecutor, SandboxResult } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExecuteResult =
  | { readonly ok: true; readonly value: SandboxResult }
  | { readonly ok: false; readonly error: SandboxError };

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

const DEFAULT_LRU_CAP = 256;

interface LruCache<K, V> {
  readonly get: (key: K) => V | undefined;
  readonly set: (key: K, value: V) => void;
  readonly size: number;
}

function createLruCache<K, V>(capacity: number): LruCache<K, V> {
  const map = new Map<K, V>();

  return {
    get(key: K): V | undefined {
      const value = map.get(key);
      if (value !== undefined) {
        // Move to end (most recently used)
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key: K, value: V): void {
      if (map.has(key)) {
        map.delete(key);
      } else if (map.size >= capacity) {
        // Evict least recently used (first entry)
        const first = map.keys().next().value;
        if (first !== undefined) {
          map.delete(first);
        }
      }
      map.set(key, value);
    },
    get size(): number {
      return map.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyError(e: unknown, durationMs: number): SandboxError {
  const message = e instanceof Error ? e.message : String(e);

  if (message.includes("Permission denied") || message.includes("EACCES")) {
    return { code: "PERMISSION", message, durationMs };
  }

  return { code: "CRASH", message, durationMs };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type CompiledFn = (input: unknown) => unknown;
type ImportedModule = { readonly default: CompiledFn };

// let justified: mutable monotonic counter for cache busting
let bustCounter = 0;

export function createPromotedExecutor(): SandboxExecutor {
  const fnCache = createLruCache<string, CompiledFn>(DEFAULT_LRU_CAP);
  const importCache = createLruCache<string, ImportedModule>(DEFAULT_LRU_CAP);

  const execute = async (
    code: string,
    input: unknown,
    timeoutMs: number,
    context?: ExecutionContext,
  ): Promise<ExecuteResult> => {
    const start = performance.now();

    try {
      // Import path: use dynamic import() when entryPath is provided
      if (context?.entryPath !== undefined) {
        const cached = importCache.get(context.entryPath);
        // let justified: mod is conditionally assigned from cache or import
        let mod: ImportedModule;

        if (cached !== undefined) {
          mod = cached;
        } else {
          // Query-string cache busting to force fresh import after content changes
          bustCounter += 1;
          const importPath = `${context.entryPath}?bust=${String(bustCounter)}`;
          mod = (await import(importPath)) as ImportedModule;
          importCache.set(context.entryPath, mod);
        }

        const fn = mod.default;
        if (typeof fn !== "function") {
          return {
            ok: false,
            error: {
              code: "CRASH",
              message: "Brick module must export a default function",
              durationMs: performance.now() - start,
            },
          };
        }

        // let justified: timeoutId set inside Promise constructor, cleared in finally
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const result: unknown = await Promise.race([
            Promise.resolve(fn(input)),
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                reject(new Error(`Execution timed out after ${String(timeoutMs)}ms`));
              }, timeoutMs);
            }),
          ]);

          const durationMs = performance.now() - start;
          return { ok: true, value: { output: result, durationMs } };
        } finally {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
        }
      }

      // Fallback: new Function() for bricks without dependencies
      const fnCached = fnCache.get(code);
      // let justified: fn is conditionally assigned from cache or constructor
      let fn: CompiledFn;
      if (fnCached !== undefined) {
        fn = fnCached;
      } else {
        fn = new Function("input", code) as CompiledFn;
        fnCache.set(code, fn);
      }

      const result: unknown = await Promise.resolve(fn(input));
      const durationMs = performance.now() - start;

      return { ok: true, value: { output: result, durationMs } };
    } catch (e: unknown) {
      const durationMs = performance.now() - start;
      return { ok: false, error: classifyError(e, durationMs) };
    }
  };

  return { execute };
}
