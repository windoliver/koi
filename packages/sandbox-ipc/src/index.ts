/**
 * @koi/sandbox-ipc — IPC bridge for sandboxed code execution (Layer 2)
 *
 * Connects OS-level sandboxing with forge verification by providing
 * structured IPC between host and sandboxed Bun child processes.
 *
 * Depends on @koi/core (L0) only. The sandbox command builder is injected
 * via BridgeConfig.buildCommand to avoid L2→L2 peer imports.
 */

// Adapter
export { bridgeToExecutor } from "./adapter.js";
// Bridge
export type { CreateBridgeOptions } from "./bridge.js";
export { createSandboxBridge } from "./bridge.js";
// Errors
export { createIpcError, mapIpcErrorToKoi, mapIpcErrorToSandbox } from "./errors.js";
// Protocol types
export type {
  ErrorMessage,
  ExecuteMessage,
  ParseResult,
  ReadyMessage,
  ResultMessage,
  WorkerMessage,
} from "./protocol.js";
// Protocol validation functions
export {
  parseErrorMessage,
  parseExecuteMessage,
  parseReadyMessage,
  parseResultMessage,
  parseWorkerMessage,
} from "./protocol.js";
// Types
export type {
  BridgeConfig,
  BridgeExecOptions,
  BridgeResult,
  CommandBuilder,
  IpcError,
  IpcErrorCode,
  IpcProcess,
  SandboxBridge,
  SandboxCommand,
  SpawnFn,
} from "./types.js";
