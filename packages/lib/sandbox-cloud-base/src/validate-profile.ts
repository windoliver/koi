import type { SandboxProfile } from "@koi/core";

export interface UnsupportedProfileFields {
  readonly filesystem: boolean;
  readonly network: boolean;
  readonly resources: boolean;
  readonly details: readonly string[];
}

export function detectUnsupportedProfileFields(
  profile: SandboxProfile,
): UnsupportedProfileFields | undefined {
  const fields: string[] = [];
  let filesystem = false;
  let network = false;
  let resources = false;

  if (profile.network.allow === false) {
    fields.push("network.allow=false");
    network = true;
  }

  const filesystemPolicy = profile.filesystem;
  if (filesystemPolicy.defaultReadAccess === "closed") {
    fields.push("filesystem.defaultReadAccess=closed");
    filesystem = true;
  }
  if (filesystemPolicy.allowRead !== undefined && filesystemPolicy.allowRead.length > 0) {
    fields.push("filesystem.allowRead");
    filesystem = true;
  }
  if (filesystemPolicy.denyRead !== undefined && filesystemPolicy.denyRead.length > 0) {
    fields.push("filesystem.denyRead");
    filesystem = true;
  }
  if (filesystemPolicy.allowWrite !== undefined && filesystemPolicy.allowWrite.length > 0) {
    fields.push("filesystem.allowWrite");
    filesystem = true;
  }
  if (filesystemPolicy.denyWrite !== undefined && filesystemPolicy.denyWrite.length > 0) {
    fields.push("filesystem.denyWrite");
    filesystem = true;
  }

  if (profile.nexusMounts !== undefined && profile.nexusMounts.length > 0) {
    fields.push("nexusMounts");
    filesystem = true;
  }

  const resourceLimits = profile.resources;
  if (resourceLimits.maxMemoryMb !== undefined) {
    fields.push("resources.maxMemoryMb");
    resources = true;
  }
  if (resourceLimits.maxPids !== undefined) {
    fields.push("resources.maxPids");
    resources = true;
  }
  if (resourceLimits.maxOpenFiles !== undefined) {
    fields.push("resources.maxOpenFiles");
    resources = true;
  }

  return fields.length === 0
    ? undefined
    : {
        filesystem,
        network,
        resources,
        details: fields,
      };
}

export function formatUnsupportedProfileError(
  adapterName: string,
  unsupported: UnsupportedProfileFields,
): string {
  const details =
    unsupported.details.length === 0
      ? "requested profile fields are not supported"
      : unsupported.details.join(", ");

  return (
    `${adapterName} cannot enforce profile fields: ${details}. ` +
    "Use @koi/sandbox-docker or @koi/sandbox-os for policy enforcement. " +
    "Refuse to provision rather than silently weakening isolation."
  );
}
