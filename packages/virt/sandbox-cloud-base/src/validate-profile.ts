/**
 * Profile validation — checks whether a SandboxProfile contains policies
 * that cloud adapters cannot enforce.
 *
 * Cloud sandbox providers (E2B, Cloudflare, Daytona, Vercel) do not support
 * arbitrary filesystem, network, or resource policies. This function detects
 * restrictive policies and returns a descriptive error so callers fail-closed
 * instead of silently ignoring security policy.
 */

import type { SandboxProfile } from "@koi/core";

/** Unsupported profile fields detected by validation. */
export interface UnsupportedProfileFields {
  readonly filesystem: boolean;
  readonly network: boolean;
  readonly resources: boolean;
  readonly env: boolean;
  readonly details: readonly string[];
}

/**
 * Check whether a SandboxProfile contains restrictive policies that a cloud
 * adapter cannot enforce.
 *
 * Returns undefined when the profile is permissive (nothing to enforce),
 * or an UnsupportedProfileFields describing what cannot be honored.
 */
export function detectUnsupportedProfileFields(
  profile: SandboxProfile,
): UnsupportedProfileFields | undefined {
  const details: string[] = [];

  // Filesystem: any deny rules or non-trivial allow rules indicate restrictions
  const fs = profile.filesystem;
  const hasFilesystemRestrictions =
    (fs.denyRead !== undefined && fs.denyRead.length > 0) ||
    (fs.denyWrite !== undefined && fs.denyWrite.length > 0) ||
    (fs.allowRead !== undefined && fs.allowRead.length > 0 && !fs.allowRead.includes("/")) ||
    (fs.allowWrite !== undefined && fs.allowWrite.length > 0 && !fs.allowWrite.includes("/"));

  if (hasFilesystemRestrictions) {
    details.push("filesystem policy (allowRead/denyRead/allowWrite/denyWrite)");
  }

  // Network: deny or host-restricted
  const hasNetworkRestrictions =
    !profile.network.allow ||
    (profile.network.allowedHosts !== undefined && profile.network.allowedHosts.length > 0);

  if (hasNetworkRestrictions) {
    details.push(
      !profile.network.allow
        ? "network deny (allow=false)"
        : "network host restrictions (allowedHosts)",
    );
  }

  // Resources: any limits set
  const r = profile.resources;
  const hasResourceRestrictions =
    r.maxMemoryMb !== undefined || r.maxPids !== undefined || r.maxOpenFiles !== undefined;

  if (hasResourceRestrictions) {
    details.push("resource limits (maxMemoryMb/maxPids/maxOpenFiles)");
  }

  // Env: cloud adapters don't forward env to container
  const hasEnv = profile.env !== undefined && Object.keys(profile.env).length > 0;

  if (hasEnv) {
    details.push("environment variables");
  }

  if (details.length === 0) {
    return undefined;
  }

  return {
    filesystem: hasFilesystemRestrictions,
    network: hasNetworkRestrictions,
    resources: hasResourceRestrictions,
    env: hasEnv,
    details,
  };
}

/**
 * Build an error message for unsupported profile fields.
 */
export function formatUnsupportedProfileError(
  adapterName: string,
  unsupported: UnsupportedProfileFields,
): string {
  return (
    `${adapterName} adapter cannot enforce the following SandboxProfile policies: ` +
    `${unsupported.details.join(", ")}. ` +
    `Use the Docker or OS adapter for policy enforcement, ` +
    `or relax the profile to proceed.`
  );
}
