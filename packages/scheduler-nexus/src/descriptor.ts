/**
 * BrickDescriptor for @koi/scheduler-nexus.
 *
 * Enables manifest auto-resolution: validates Nexus task queue config,
 * then creates the TaskQueueBackend backed by Nexus Astraea.
 */

import type { KoiError, Result, TaskQueueBackend } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";
import { validateNexusTaskQueueConfig } from "./config.js";
import { createNexusTaskQueue } from "./nexus-queue.js";

function validateSchedulerNexusOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Scheduler-nexus options must be an object with baseUrl and apiKey",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const result = validateNexusTaskQueueConfig(input);
  if (!result.ok) return result;

  return { ok: true, value: input };
}

export const schedulerNexusDescriptor: BrickDescriptor<TaskQueueBackend> = {
  kind: "schedule",
  name: "@koi/scheduler-nexus",
  aliases: ["scheduler-nexus"],
  description: "Nexus Astraea-backed priority queue for distributed task dispatch",
  optionsValidator: validateSchedulerNexusOptions,
  factory(options: unknown): TaskQueueBackend {
    const result = validateNexusTaskQueueConfig(options);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return createNexusTaskQueue(result.value);
  },
};
