/**
 * Trivial workflow for Bun compatibility gate test.
 * Executes a single no-op activity and returns the result.
 */

import { proxyActivities } from "@temporalio/workflow";

interface TrivialActivities {
  readonly noOp: () => Promise<string>;
}

const { noOp } = proxyActivities<TrivialActivities>({
  startToCloseTimeout: "10 seconds",
});

export async function trivialWorkflow(): Promise<string> {
  return noOp();
}
