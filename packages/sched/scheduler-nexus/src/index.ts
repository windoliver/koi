/**
 * @koi/scheduler-nexus — Nexus Astraea-backed priority queue (Layer 2)
 *
 * Thin HTTP client implementing TaskQueueBackend that delegates
 * priority dispatch to Nexus while Koi retains cron/timing/retry.
 * Pass the resulting TaskQueueBackend to createScheduler's queueBackend param.
 */

export type { NexusTaskQueueConfig } from "./config.js";
export { validateNexusTaskQueueConfig } from "./config.js";
export { schedulerNexusDescriptor } from "./descriptor.js";
export { createNexusTaskQueue } from "./nexus-queue.js";
