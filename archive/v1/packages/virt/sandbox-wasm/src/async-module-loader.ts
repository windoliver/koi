/**
 * Lazy singleton for the QuickJS async (asyncify) Wasm module.
 *
 * Mirrors module-loader.ts but uses the asyncify variant, which allows
 * host async functions to be called from within the guest sandbox.
 *
 * The asyncify build is ~2x larger and ~40% slower than the sync variant,
 * so it should only be used when host async callbacks are needed.
 *
 * If loading fails, the cached promise is cleared so the next call retries.
 */

import type { QuickJSAsyncWASMModule } from "quickjs-emscripten-core";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";

// Justified `let`: one-time lazy initialization of a module-level singleton.
let modulePromise: Promise<QuickJSAsyncWASMModule> | undefined;

async function loadModule(): Promise<QuickJSAsyncWASMModule> {
  try {
    return await newQuickJSAsyncWASMModuleFromVariant(
      import("@jitl/quickjs-ng-wasmfile-release-asyncify"),
    );
  } catch (cause: unknown) {
    modulePromise = undefined;
    throw new Error("Failed to load QuickJS async Wasm module", { cause });
  }
}

export function getAsyncModule(): Promise<QuickJSAsyncWASMModule> {
  if (modulePromise === undefined) {
    modulePromise = loadModule();
  }
  return modulePromise;
}
