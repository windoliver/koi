/**
 * Composite factory for Nexus-backed scheduler backends.
 *
 * Creates TaskStore, ScheduleStore, and TaskQueueBackend from a single
 * NexusSchedulerConfig, wiring shared NexusClient internally.
 */

import type { ScheduleStore, TaskQueueBackend, TaskStore } from "@koi/core";
import { createNexusClient } from "@koi/nexus-client";
import { createNexusTaskQueue } from "./nexus-queue.js";
import { createNexusScheduleStore } from "./nexus-schedule-store.js";
import { createNexusTaskStore } from "./nexus-task-store.js";
import type { NexusSchedulerConfig } from "./scheduler-config.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface NexusSchedulerBackends {
  readonly taskStore: TaskStore;
  readonly scheduleStore: ScheduleStore;
  readonly queueBackend: TaskQueueBackend;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create all three Nexus-backed scheduler backends from a single config.
 *
 * Internally creates a shared NexusClient for TaskStore and ScheduleStore
 * (JSON-RPC), while TaskQueueBackend uses REST (existing pattern).
 */
export function createNexusSchedulerBackends(config: NexusSchedulerConfig): NexusSchedulerBackends {
  const client = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  return {
    taskStore: createNexusTaskStore(client),
    scheduleStore: createNexusScheduleStore(client),
    queueBackend: createNexusTaskQueue(config),
  };
}
