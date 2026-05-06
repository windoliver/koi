/**
 * `WasmExecutor` — package-local contract for in-process WebAssembly execution.
 *
 * Deliberately NOT `SandboxExecutor` (which is a `code: string` contract).
 * Treating WASM bytes as a string would silently break router selection;
 * see the spec's "Why wasm does not implement SandboxExecutor" section.
 *
 * Input is `Uint8Array` only — precompiled `WebAssembly.Module` is rejected
 * because the host cannot recover original bytes for the binary scanner.
 */

import type { Result } from "@koi/core";

export type WasmErrorCode =
  | "INVALID_BYTES"
  | "VALIDATION"
  | "MISSING_EXPORT"
  | "EXPORT_NOT_CALLABLE"
  | "TIMEOUT"
  | "OOM"
  | "TRAP"
  | "INSTANTIATE_FAILED";

export interface WasmError {
  readonly code: WasmErrorCode;
  readonly message: string;
  readonly durationMs: number;
  readonly cause?: unknown;
}

export interface WasmResult {
  readonly output: unknown;
  readonly durationMs: number;
}

export interface WasmCall {
  readonly export: string;
  readonly args: readonly unknown[];
}

/** Imports object for `WebAssembly.instantiate` — module-name → import-name → value. */
export type WasmImports = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface WasmExecuteOptions {
  readonly timeoutMs?: number;
  readonly maxMemoryPages?: number;
  readonly imports?: WasmImports;
}

export interface WasmExecutor {
  readonly execute: (
    moduleBytes: Uint8Array,
    call: WasmCall,
    options?: WasmExecuteOptions,
  ) => Promise<Result<WasmResult, WasmError>>;
}
