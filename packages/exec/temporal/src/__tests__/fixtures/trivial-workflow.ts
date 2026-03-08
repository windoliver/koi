/**
 * Trivial workflow for Bun compatibility gate test.
 * Executes a single no-op activity and returns the result.
 */

import type { ActivityOptions } from "@temporalio/workflow";
import { executeActivity } from "@temporalio/workflow";

const ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: "10 seconds",
};

export async function trivialWorkflow(): Promise<string> {
  return executeActivity<() => Promise<string>>("noOp", ACTIVITY_OPTIONS);
}
