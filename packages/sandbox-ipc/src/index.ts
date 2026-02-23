/**
 * @koi/sandbox-ipc — IPC bridge for sandboxed code execution (Layer 2)
 *
 * Connects OS-level sandboxing (@koi/sandbox) with forge verification
 * (@koi/forge) by providing structured IPC between host and sandboxed
 * Bun child processes.
 *
 * Depends on @koi/core (L0) and @koi/sandbox (L2 peer — allowed per plan).
 */

// Adapter
export { bridgeToExecutor } from "./adapter.js";
// Bridge
export type { CreateBridgeOptions } from "./bridge.js";
export { createSandboxBridge } from "./bridge.js";
// Errors
export { createIpcError, ipcErrorToKoiError, ipcErrorToSandboxError } from "./errors.js";
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
  IpcError,
  IpcErrorCode,
  IpcProcess,
  SandboxBridge,
  SpawnFn,
} from "./types.js";
