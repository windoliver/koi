import type { SandboxProfile } from "@koi/core";

export interface UnsupportedProfileFields {
  readonly fields: readonly string[];
}

const DEFAULT_ADAPTER_NAME = "sandbox-cloud-base";

export function detectUnsupportedProfileFields(
  profile: SandboxProfile,
): UnsupportedProfileFields | undefined {
  const fields: string[] = [];

  if (profile.network.allow === false) {
    fields.push("network.allow=false");
  }

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

  return fields.length === 0 ? undefined : { fields };
}

export function formatUnsupportedProfileError(
  unsupported: UnsupportedProfileFields,
  adapterName: string = DEFAULT_ADAPTER_NAME,
): string {
  const details =
    unsupported.fields.length === 0
      ? "requested profile fields are not supported"
      : unsupported.fields.join(", ");

  return (
    `${adapterName} cannot enforce profile fields: ${details}. ` +
    "Refuse to provision rather than silently weakening isolation."
  );
}

export interface ProfileDefaults {
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export function extractProfileDefaults(profile: SandboxProfile): ProfileDefaults {
  return {
    ...(profile.env !== undefined ? { env: profile.env } : {}),
    ...(profile.resources.timeoutMs !== undefined
      ? { timeoutMs: profile.resources.timeoutMs }
      : {}),
  };
}
