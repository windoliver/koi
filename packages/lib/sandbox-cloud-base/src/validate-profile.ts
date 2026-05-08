import type { SandboxProfile } from "@koi/core";

export interface UnsupportedProfileFields {
  readonly filesystem: boolean;
  readonly network: boolean;
  readonly resources: boolean;
  readonly details: readonly string[];
}

function hasUnsupportedFilesystem(profile: SandboxProfile): boolean {
  const fs = profile.filesystem;
  if (fs.defaultReadAccess === "closed") return true;
  if (fs.allowRead !== undefined && fs.allowRead.length > 0) return true;
  if (fs.denyRead !== undefined && fs.denyRead.length > 0) return true;
  if (fs.allowWrite !== undefined && fs.allowWrite.length > 0) return true;
  if (fs.denyWrite !== undefined && fs.denyWrite.length > 0) return true;
  if (profile.nexusMounts !== undefined && profile.nexusMounts.length > 0) return true;
  return false;
}

function hasUnsupportedResources(profile: SandboxProfile): boolean {
  const r = profile.resources;
  return r.maxMemoryMb !== undefined || r.maxPids !== undefined || r.maxOpenFiles !== undefined;
}

export function detectUnsupportedProfileFields(
  profile: SandboxProfile,
): UnsupportedProfileFields | undefined {
  const filesystem = hasUnsupportedFilesystem(profile);
  const network = profile.network.allow === false;
  const resources = hasUnsupportedResources(profile);

  const details: string[] = [];
  if (filesystem) details.push("filesystem restrictions or Nexus mounts");
  if (network) details.push("network deny (allow=false)");
  if (resources) details.push("resource limits (maxMemoryMb/maxPids/maxOpenFiles)");

  return details.length === 0 ? undefined : { filesystem, network, resources, details };
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
