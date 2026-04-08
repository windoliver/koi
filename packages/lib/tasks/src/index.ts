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
export { createManagedTaskBoard, type ManagedTaskBoard, type ManagedTaskBoardConfig } from "./managed-board.js";
export { createMemoryTaskBoardStore } from "./memory-store.js";

// Output streaming
export { createOutputStream, type OutputChunk, type OutputStreamConfig, type TaskOutputStream } from "./output-stream.js";

// Runtime task kinds
export {
  type DreamTask,
  type InProcessTeammateTask,
  type LocalAgentTask,
  type LocalShellTask,
  type PlanApprovalSnapshot,
  type RemoteAgentTask,
  type RuntimeTask,
  type RuntimeTaskBase,
  type TeammateIdentity,
  isDreamTask,
  isInProcessTeammateTask,
  isLocalAgentTask,
  isLocalShellTask,
  isRemoteAgentTask,
  isRuntimeTask,
} from "./task-kinds.js";

// Task registry
export { type TaskKindLifecycle, type TaskRegistry, createTaskRegistry } from "./task-registry.js";

// Task runner
export { type OutputDelta, type TaskRunner, type TaskRunnerConfig, createTaskRunner } from "./task-runner.js";

// Lifecycles
export { type LocalShellConfig, createLocalShellLifecycle } from "./lifecycles/local-shell.js";
