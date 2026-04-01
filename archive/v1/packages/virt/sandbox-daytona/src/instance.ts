/**
 * Daytona SandboxInstance implementation — delegates to shared cloud instance factory.
 */

import type { SandboxInstance } from "@koi/core";
import { createCloudInstance } from "@koi/sandbox-cloud-base";
import { classifyDaytonaError } from "./classify.js";
import type { DaytonaSdkSandbox } from "./types.js";

/** Create a SandboxInstance backed by a Daytona SDK sandbox. */
export function createDaytonaInstance(sdk: DaytonaSdkSandbox): SandboxInstance {
  return createCloudInstance({
    sdk,
    classifyError: classifyDaytonaError,
    destroy: () => sdk.close(),
    name: "daytona",
    // Daytona workspaces persist by default — detach = close without delete
    detach: () => sdk.close(),
  });
}
