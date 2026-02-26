/**
 * BrickDescriptor for @koi/middleware-sandbox.
 *
 * Enables manifest auto-resolution: validates sandbox config,
 * then creates the sandbox middleware with default trust tier profiles.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import type { TrustTier } from "@koi/core/ecs";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { SandboxProfile } from "@koi/core/sandbox-profile";
import type { BrickDescriptor } from "@koi/resolve";
import { createSandboxMiddleware } from "./sandbox-middleware.js";

function validateSandboxDescriptorOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Sandbox options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input };
}

/**
 * Default sandbox profiles by trust tier.
 * Sandbox tier: restricted. Verified: moderate. Promoted: unrestricted.
 */
const DEFAULT_PROFILES: Readonly<Record<TrustTier, SandboxProfile>> = {
  sandbox: {
    tier: "sandbox",
    filesystem: { allowRead: [], allowWrite: [] },
    network: { allow: false, allowedHosts: [] },
    resources: { maxMemoryMb: 256, timeoutMs: 30_000 },
  },
  verified: {
    tier: "verified",
    filesystem: { allowRead: ["**"], allowWrite: [] },
    network: { allow: true, allowedHosts: ["*"] },
    resources: { maxMemoryMb: 512, timeoutMs: 60_000 },
  },
  promoted: {
    tier: "promoted",
    filesystem: { allowRead: ["**"], allowWrite: ["**"] },
    network: { allow: true, allowedHosts: ["*"] },
    resources: { maxMemoryMb: 1024, timeoutMs: 120_000 },
  },
} as const;

/**
 * Descriptor for sandbox middleware.
 * Uses default trust tier profiles and treats all tools as sandbox tier.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/middleware-sandbox",
  aliases: ["sandbox"],
  optionsValidator: validateSandboxDescriptorOptions,
  factory(): KoiMiddleware {
    return createSandboxMiddleware({
      profileFor: (tier: TrustTier): SandboxProfile => DEFAULT_PROFILES[tier],
      tierFor: (): TrustTier => "sandbox",
    });
  },
};
