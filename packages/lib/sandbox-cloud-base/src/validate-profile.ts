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
  let filesystem = false;
  let network = false;
  let resources = false;

  if (profile.network.allow === false) {
    network = true;
  }

  const filesystemPolicy = profile.filesystem;
  if (filesystemPolicy.defaultReadAccess === "closed") {
    filesystem = true;
  }
  if (filesystemPolicy.allowRead !== undefined && filesystemPolicy.allowRead.length > 0) {
    filesystem = true;
  }
  if (filesystemPolicy.denyRead !== undefined && filesystemPolicy.denyRead.length > 0) {
    filesystem = true;
  }
  if (filesystemPolicy.allowWrite !== undefined && filesystemPolicy.allowWrite.length > 0) {
    filesystem = true;
  }
  if (filesystemPolicy.denyWrite !== undefined && filesystemPolicy.denyWrite.length > 0) {
    filesystem = true;
  }

  if (profile.nexusMounts !== undefined && profile.nexusMounts.length > 0) {
    filesystem = true;
  }

  const resourceLimits = profile.resources;
  if (resourceLimits.maxMemoryMb !== undefined) {
    resources = true;
  }
  if (resourceLimits.maxPids !== undefined) {
    resources = true;
  }
  if (resourceLimits.maxOpenFiles !== undefined) {
    resources = true;
  }

  const details: string[] = [];
  if (filesystem) {
    details.push("filesystem restrictions or Nexus mounts");
  }
  if (network) {
    details.push("network deny (allow=false)");
  }
  if (resources) {
    details.push("resource limits (maxMemoryMb/maxPids/maxOpenFiles)");
  }

  return details.length === 0
    ? undefined
    : {
        filesystem,
        network,
        resources,
        details,
      };
}

export function formatUnsupportedProfileError(
  adapterName: string,
  unsupported: UnsupportedProfileFields,
): string {
  return (
    `${adapterName} cannot enforce the following SandboxProfile policies: ` +
    `${unsupported.details.join(", ")}. ` +
    "Use @koi/sandbox-docker or @koi/sandbox-os for policy enforcement, or relax the profile to proceed."
  );
}
