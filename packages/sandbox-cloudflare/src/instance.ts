/**
 * Cloudflare SandboxInstance implementation — delegates to shared cloud instance factory.
 */

import type { SandboxInstance } from "@koi/core";
import { createCloudInstance } from "@koi/sandbox-cloud-base";
import { classifyCloudflareError } from "./classify.js";
import type { CfSdkSandbox } from "./types.js";

/** Create a SandboxInstance backed by a Cloudflare SDK sandbox. */
export function createCloudflareInstance(sdk: CfSdkSandbox): SandboxInstance {
  return createCloudInstance({
    sdk,
    classifyError: classifyCloudflareError,
    destroy: () => sdk.close(),
    name: "cloudflare",
  });
}
