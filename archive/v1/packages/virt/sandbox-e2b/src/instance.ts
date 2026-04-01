/**
 * E2B SandboxInstance implementation — delegates to shared cloud instance factory.
 */

import type { SandboxInstance } from "@koi/core";
import { createCloudInstance } from "@koi/sandbox-cloud-base";
import { classifyE2bError } from "./classify.js";
import type { E2bSdkSandbox } from "./types.js";

/** Create a SandboxInstance backed by an E2B SDK sandbox. */
export function createE2bInstance(sdk: E2bSdkSandbox): SandboxInstance {
  const pauseFn = sdk.pause;
  return createCloudInstance({
    sdk,
    classifyError: classifyE2bError,
    destroy: () => sdk.kill(),
    name: "e2b",
    ...(pauseFn !== undefined ? { detach: () => pauseFn() } : {}),
  });
}
