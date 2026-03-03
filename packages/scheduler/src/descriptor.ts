/**
 * BrickDescriptor for @koi/scheduler.
 *
 * Enables manifest auto-resolution for the task scheduler.
 * Validates cron schedule definitions from the manifest.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";

/** Schedule entry as it appears in the manifest. */
interface ScheduleEntry {
  readonly id: string;
  readonly expression: string;
  readonly input?: Record<string, unknown>;
  readonly enabled?: boolean;
}

function isScheduleArray(value: unknown): value is readonly ScheduleEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).expression === "string",
    )
  );
}

function validateSchedulerDescriptorOptions(
  input: unknown,
): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "Scheduler");
  if (!base.ok) return base;
  const opts = base.value;

  if (opts.schedules !== undefined && !isScheduleArray(opts.schedules)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "scheduler.schedules must be an array of { id, expression } objects",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: opts };
}

/**
 * Descriptor for the scheduler.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<unknown> = {
  kind: "schedule",
  name: "@koi/scheduler",
  aliases: ["scheduler", "schedule"],
  optionsValidator: validateSchedulerDescriptorOptions,
  factory(options): unknown {
    // Return the schedule configuration — actual scheduler creation
    // requires runtime services (store, dispatcher) that CLI will provide
    return options;
  },
};
