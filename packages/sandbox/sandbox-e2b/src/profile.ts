import type { SandboxProfile } from "@koi/core";
import {
  detectUnsupportedProfileFields as detectSharedUnsupportedProfileFields,
  type UnsupportedProfileFields as SharedUnsupportedProfileFields,
} from "@koi/sandbox-cloud-base";

/** Fields the hosted E2B adapter cannot currently enforce remotely. */
export interface UnsupportedProfileFields {
  readonly fields: readonly string[];
}

/**
 * Detect profile fields this adapter cannot enforce on the hosted side.
 *
 * Preserves the legacy sandbox-e2b helper contract while delegating the
 * underlying hosted-policy detection to the shared cloud-base helper.
 */
export function detectUnsupportedProfileFields(
  profile: SandboxProfile,
): UnsupportedProfileFields | undefined {
  const unsupported = detectSharedUnsupportedProfileFields(profile);
  if (unsupported === undefined) return undefined;

  return {
    fields: mapSharedUnsupportedFieldsToLegacyFields(profile, unsupported),
  };
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

function mapSharedUnsupportedFieldsToLegacyFields(
  profile: SandboxProfile,
  unsupported: SharedUnsupportedProfileFields,
): string[] {
  const fields: string[] = [];

  if (unsupported.network) {
    fields.push("network.allow=false");
  }

  if (unsupported.filesystem) {
    const filesystem = profile.filesystem;
    if (filesystem.defaultReadAccess === "closed") {
      fields.push("filesystem.defaultReadAccess=closed");
    }
    if (filesystem.allowRead !== undefined && filesystem.allowRead.length > 0) {
      fields.push("filesystem.allowRead");
    }
    if (filesystem.denyRead !== undefined && filesystem.denyRead.length > 0) {
      fields.push("filesystem.denyRead");
    }
    if (filesystem.allowWrite !== undefined && filesystem.allowWrite.length > 0) {
      fields.push("filesystem.allowWrite");
    }
    if (filesystem.denyWrite !== undefined && filesystem.denyWrite.length > 0) {
      fields.push("filesystem.denyWrite");
    }
    if (profile.nexusMounts !== undefined && profile.nexusMounts.length > 0) {
      fields.push("nexusMounts");
    }
  }

  if (unsupported.resources) {
    const resources = profile.resources;
    if (resources.maxMemoryMb !== undefined) {
      fields.push("resources.maxMemoryMb");
    }
    if (resources.maxPids !== undefined) {
      fields.push("resources.maxPids");
    }
    if (resources.maxOpenFiles !== undefined) {
      fields.push("resources.maxOpenFiles");
    }
  }

  return fields;
}
