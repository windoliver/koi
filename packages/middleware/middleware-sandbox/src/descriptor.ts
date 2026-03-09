/**
 * BrickDescriptor for @koi/middleware-sandbox.
 *
 * Enables manifest auto-resolution: validates sandbox config,
 * then creates the sandbox middleware with default profiles.
 */

import type { KoiMiddleware, ToolPolicy } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import type { SandboxProfile } from "@koi/core/sandbox-profile";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createSandboxMiddleware } from "./sandbox-middleware.js";

/** Default sandbox profile for sandboxed tools. */
const DEFAULT_SANDBOX_PROFILE: SandboxProfile = {
  filesystem: { allowRead: [], allowWrite: [] },
  network: { allow: false, allowedHosts: [] },
  resources: { maxMemoryMb: 256, timeoutMs: 30_000 },
} as const;

/** Default profile for unsandboxed tools (unrestricted). */
const DEFAULT_UNSANDBOXED_PROFILE: SandboxProfile = {
  filesystem: { allowRead: ["**"], allowWrite: ["**"] },
  network: { allow: true, allowedHosts: ["*"] },
  resources: { maxMemoryMb: 1024, timeoutMs: 120_000 },
} as const;

/**
 * Descriptor for sandbox middleware.
 * Uses policy.sandbox boolean to determine which profile to apply.
 * Exported for registration with createRegistry().
 *
 * NOTE: This descriptor defaults all tools to sandboxed policy via
 * DEFAULT_SANDBOXED_POLICY. The unsandboxed profile branch in profileFor
 * is only reachable when callers use createSandboxMiddleware() directly
 * with a custom policyFor that returns policies with sandbox=false.
 * For custom policy resolution, use createSandboxMiddleware() directly
 * instead of the descriptor auto-resolution path.
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-sandbox",
  aliases: ["sandbox"],
  optionsValidator: (input) => validateRequiredDescriptorOptions(input, "Sandbox"),
  factory(): KoiMiddleware {
    return createSandboxMiddleware({
      profileFor: (policy: ToolPolicy): SandboxProfile =>
        policy.sandbox ? DEFAULT_SANDBOX_PROFILE : DEFAULT_UNSANDBOXED_PROFILE,
      policyFor: (): ToolPolicy => DEFAULT_SANDBOXED_POLICY,
    });
  },
};
