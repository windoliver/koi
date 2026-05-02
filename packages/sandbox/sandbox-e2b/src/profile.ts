import type { SandboxProfile } from "@koi/core";

/** Fields the hosted E2B adapter cannot currently enforce remotely. */
export interface UnsupportedProfileFields {
  readonly fields: readonly string[];
}

/**
 * Detect profile fields this adapter cannot enforce on the hosted side.
 *
 * Returns `undefined` when the profile is fully supportable. Fail-closed: if
 * the caller asks for restrictive isolation we can't enforce remotely (e.g.,
 * `network.allow=false`, filesystem allow/deny lists, nexus mounts), we
 * surface the unsupported list so the caller knows policy was *not* applied.
 *
 * Provider-side enforcement of these fields lands with `@koi/sandbox-cloud-base`
 * (issue #1379); until then the adapter must refuse rather than silently
 * pretend to enforce them.
 */
export function detectUnsupportedProfileFields(
  profile: SandboxProfile,
): UnsupportedProfileFields | undefined {
  const fields: string[] = [];

  if (profile.network.allow === false) fields.push("network.allow=false");

  const fs = profile.filesystem;
  if (fs.defaultReadAccess === "closed") fields.push("filesystem.defaultReadAccess=closed");
  if (fs.allowRead !== undefined && fs.allowRead.length > 0) fields.push("filesystem.allowRead");
  if (fs.denyRead !== undefined && fs.denyRead.length > 0) fields.push("filesystem.denyRead");
  if (fs.allowWrite !== undefined && fs.allowWrite.length > 0) fields.push("filesystem.allowWrite");
  if (fs.denyWrite !== undefined && fs.denyWrite.length > 0) fields.push("filesystem.denyWrite");

  if (profile.nexusMounts !== undefined && profile.nexusMounts.length > 0) {
    fields.push("nexusMounts");
  }

  // Resource-limit fields the hosted backend cannot enforce yet.
  const r = profile.resources;
  if (r.maxMemoryMb !== undefined) fields.push("resources.maxMemoryMb");
  if (r.maxPids !== undefined) fields.push("resources.maxPids");
  if (r.maxOpenFiles !== undefined) fields.push("resources.maxOpenFiles");

  if (fields.length === 0) return undefined;
  return { fields };
}

/** Profile defaults the adapter *can* honour and forwards to per-call exec. */
export interface ProfileDefaults {
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Extract supported profile defaults forwarded to per-call exec. */
export function extractProfileDefaults(profile: SandboxProfile): ProfileDefaults {
  return {
    ...(profile.env !== undefined ? { env: profile.env } : {}),
    ...(profile.resources.timeoutMs !== undefined
      ? { timeoutMs: profile.resources.timeoutMs }
      : {}),
  };
}

export function formatUnsupportedProfileError(unsupported: UnsupportedProfileFields): string {
  return `sandbox-e2b cannot enforce profile fields: ${unsupported.fields.join(
    ", ",
  )}. The hosted backend has no provider-side hook for these yet (tracked in #1379). Refuse to provision rather than silently weakening isolation.`;
}
