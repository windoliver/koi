/**
 * Vercel SandboxInstance implementation — delegates to shared cloud instance factory.
 */

import type { SandboxInstance } from "@koi/core";
import { createCloudInstance } from "@koi/sandbox-cloud-base";
import { classifyVercelError } from "./classify.js";
import type { VercelSdkSandbox } from "./types.js";

/** Create a SandboxInstance backed by a Vercel SDK sandbox. */
export function createVercelInstance(sdk: VercelSdkSandbox): SandboxInstance {
  return createCloudInstance({
    sdk,
    classifyError: classifyVercelError,
    destroy: () => sdk.close(),
    name: "vercel",
  });
}
