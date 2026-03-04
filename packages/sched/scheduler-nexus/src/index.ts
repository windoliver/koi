/**
 * @koi/scheduler-nexus — Nexus-backed distributed task store, schedule store,
 * and priority queue for cross-node scheduling (Layer 2).
 *
 * Thin HTTP/JSON-RPC client implementing TaskStore, ScheduleStore, and
 * TaskQueueBackend with distributed claim/ack/nack/tick semantics.
 * Pass the resulting backends to createScheduler's parameters.
 */

export type { NexusTaskQueueConfig } from "./config.js";
export { validateNexusTaskQueueConfig } from "./config.js";
export { schedulerNexusDescriptor } from "./descriptor.js";
export { createNexusTaskQueue } from "./nexus-queue.js";
export { createNexusScheduleStore } from "./nexus-schedule-store.js";
export type { NexusSchedulerBackends } from "./nexus-scheduler.js";
export { createNexusSchedulerBackends } from "./nexus-scheduler.js";
export { createNexusTaskStore } from "./nexus-task-store.js";
export type { NexusSchedulerConfig } from "./scheduler-config.js";
export { validateNexusSchedulerConfig } from "./scheduler-config.js";
