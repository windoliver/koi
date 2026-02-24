/**
 * Lazy singleton for the QuickJS Wasm module.
 *
 * The module is loaded once on first use and reused across all executor
 * instances. This avoids re-parsing the ~500KB Wasm binary on every call
 * while keeping startup cost at zero (no top-level await).
 *
 * If loading fails, the cached promise is cleared so the next call retries.
 */

import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

// Justified `let`: one-time lazy initialization of a module-level singleton.
let modulePromise: Promise<QuickJSWASMModule> | undefined;

async function loadModule(): Promise<QuickJSWASMModule> {
  try {
    // Dynamic import returns Promise<{ default: QuickJSSyncVariant }>,
    // which satisfies the PromisedDefault<QuickJSSyncVariant> parameter type.
    return await newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-ng-wasmfile-release-sync"));
  } catch (cause: unknown) {
    modulePromise = undefined;
    throw new Error("Failed to load QuickJS Wasm module", { cause });
  }
}

export function getModule(): Promise<QuickJSWASMModule> {
  if (modulePromise === undefined) {
    modulePromise = loadModule();
  }
  return modulePromise;
}
