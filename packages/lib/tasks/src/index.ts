/**
 * @koi/tasks — Task board persistence + runtime task lifecycle (Layer 2)
 *
 * Provides:
 * - In-memory and file-based implementations of TaskBoardStore
 * - Runtime task kind types (LocalShellTask, LocalAgentTask, etc.)
 * - Task registry for lifecycle implementations
 * - Task runner for orchestrating task start/stop/output
 * - Output streaming with delta-based reads
 *
 * Depends on @koi/core (for TaskBoardStore interface and types)
 * and @koi/validation (for change notifier utility).
 */

// Persistence
export { createFileTaskBoardStore, type FileTaskBoardStoreConfig } from "./file-store.js";
export { matchesFilter } from "./filter.js";
// Lifecycles
export { registerDefaultLifecycles } from "./lifecycles/defaults.js";
export { createLocalShellLifecycle, type LocalShellConfig } from "./lifecycles/local-shell.js";
export {
  createUnsupportedLifecycle,
  isUnsupportedLifecycle,
  UNSUPPORTED_LIFECYCLE_MARKER,
  UNSUPPORTED_LIFECYCLE_MARKER_KEY,
} from "./lifecycles/unsupported.js";
export {
  createManagedTaskBoard,
  type ManagedTaskBoard,
  type ManagedTaskBoardConfig,
} from "./managed-board.js";
export { createMemoryTaskBoardStore } from "./memory-store.js";
// Output streaming
export {
  createOutputStream,
  type OutputChunk,
  type OutputStreamConfig,
  type TaskOutputStream,
} from "./output-stream.js";
// Runtime task kinds
export {
  type DreamTask,
  type InProcessTeammateTask,
  isDreamTask,
  isInProcessTeammateTask,
  isLocalAgentTask,
  isLocalShellTask,
  isRemoteAgentTask,
  isRuntimeTask,
  type LocalAgentTask,
  type LocalShellTask,
  type PlanApprovalSnapshot,
  type RemoteAgentTask,
  type RuntimeTask,
  type RuntimeTaskBase,
  type TeammateIdentity,
} from "./task-kinds.js";
// Task registry
export { createTaskRegistry, type TaskKindLifecycle, type TaskRegistry } from "./task-registry.js";
// Task runner
export {
  createTaskRunner,
  type OutputDelta,
  type TaskRunner,
  type TaskRunnerConfig,
} from "./task-runner.js";
