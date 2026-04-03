/**
 * @koi/tasks — Pluggable task board persistence (Layer 2)
 *
 * Provides in-memory and file-based implementations of TaskBoardStore
 * for persisting task board items across agent sessions.
 *
 * Depends on @koi/core (for TaskBoardStore interface and types)
 * and @koi/validation (for change notifier utility).
 */

export { createFileTaskBoardStore, type FileTaskBoardStoreConfig } from "./file-store.js";
export { matchesFilter } from "./filter.js";
export { createManagedTaskBoard, type ManagedTaskBoard, type ManagedTaskBoardConfig } from "./managed-board.js";
export { createMemoryTaskBoardStore } from "./memory-store.js";
