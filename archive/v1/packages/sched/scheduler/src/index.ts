/**
 * @koi/scheduler — L2 task scheduling package.
 *
 * Provides priority queue, cron scheduling, retry with backoff,
 * dead-letter queue, and bounded concurrency for agent dispatch.
 */

export type { Clock, FakeClock } from "./clock.js";
export { createFakeClock, createSystemClock } from "./clock.js";
export { descriptor } from "./descriptor.js";
export type { MinHeap } from "./heap.js";
export { createMinHeap } from "./heap.js";
export { computeRetryDelay } from "./retry.js";
export type { TaskDispatcher } from "./scheduler.js";
export { createScheduler } from "./scheduler.js";
export type { Semaphore } from "./semaphore.js";
export { createSemaphore } from "./semaphore.js";
export type { SqliteTaskStore } from "./sqlite-store.js";
export { createSqliteTaskStore } from "./sqlite-store.js";
export type { ProcessStateCounts } from "./stats-mapping.js";
export { mapSchedulerStatsByProcessState } from "./stats-mapping.js";
