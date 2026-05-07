import type { KoiError, Result, TaskQueueBackend } from "@koi/core";
import { type NexusTaskQueueConfig, validateNexusTaskQueueConfig } from "./config.js";
import { createNexusTaskQueue } from "./nexus-queue.js";

export interface SchedulerNexusDescriptor<T, C> {
  readonly kind: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly optionsValidator: (input: unknown) => Result<C, KoiError>;
  readonly factory: (options: unknown) => T;
}

export const schedulerNexusDescriptor: SchedulerNexusDescriptor<
  TaskQueueBackend,
  NexusTaskQueueConfig
> = {
  kind: "schedule",
  name: "@koi/scheduler-nexus",
  aliases: ["scheduler-nexus"],
  description: "Nexus-backed distributed scheduler queue backend",
  optionsValidator(input: unknown): Result<NexusTaskQueueConfig, KoiError> {
    return validateNexusTaskQueueConfig(input);
  },
  factory(options: unknown): TaskQueueBackend {
    const result = validateNexusTaskQueueConfig(options);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return createNexusTaskQueue(result.value);
  },
};
