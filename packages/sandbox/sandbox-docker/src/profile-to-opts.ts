/**
 * Maps a platform-agnostic SandboxProfile to DockerCreateOpts.
 *
 * Translation coverage:
 *   - network:   fully translated (none / bridge)
 *   - resources: maxPids → --pids-limit, maxMemoryMb → --memory
 *   - env:       forwarded directly
 *   - filesystem.allowRead  → bind mount :ro
 *   - filesystem.allowWrite → bind mount :rw + readOnlyRoot + tmpfsMounts
 *   - nexusMounts → bind mount source:mountPath (rw)
 *
 * Read-only rootfs:
 *   When filesystem.allowWrite is present (allow-list semantics), the container
 *   rootfs is made read-only via `--read-only` so only the explicit bind mounts
 *   are writable. `/tmp` is mounted as tmpfs to provide scratch space. This
 *   hardens the contract: without `--read-only`, allowWrite binds are present but
 *   the rest of the rootfs remains writable, weakening the isolation guarantee.
 *
 *   When neither allowWrite nor allowRead is present, readOnlyRoot is NOT set —
 *   the rootfs remains writable as before (caller did not opt into allow-list
 *   semantics).
 *
 * NOT translated (requires OS-level or Nexus FUSE implementation):
 *   - filesystem.denyRead / denyWrite — Docker has no fine-grained path-deny;
 *     use @koi/sandbox-os or a restrictive base image instead. Profiles with
 *     denyRead/denyWrite are REJECTED (fail-closed) to prevent silent drops.
 *   - filesystem.defaultReadAccess other than "open" — Docker only supports
 *     allow-list bind mounts; "deny"/"closed" defaults require OS-level support.
 *   - NexusFuseMount.nexusUrl / apiKey / agentId — credentials are out of
 *     scope for this adapter; Nexus FUSE daemon must be running on the host
 *     and the mount point must already exist before container creation.
 */

import type { KoiError, Result, SandboxProfile } from "@koi/core";
import { resolveDockerNetwork } from "./network.js";
import type { DockerCreateOpts } from "./types.js";

export interface ProfileMapping {
  readonly opts: DockerCreateOpts;
  readonly networkMode: "none" | "bridge";
}

/**
 * Validate that a SandboxProfile uses only filesystem semantics the Docker
 * adapter can actually enforce via bind mounts. Returns a KoiError if the
 * profile contains deny-list or deny-default fields that Docker cannot translate.
 */
export function validateProfileForDocker(profile: SandboxProfile): KoiError | undefined {
  const fs = profile.filesystem;
  if (fs.denyRead !== undefined && fs.denyRead.length > 0) {
    return {
      code: "VALIDATION",
      message:
        "sandbox-docker does not support SandboxProfile.filesystem.denyRead; use @koi/sandbox-os or compose a deny layer",
      retryable: false,
      context: { unsupported: "denyRead" },
    };
  }
  if (fs.denyWrite !== undefined && fs.denyWrite.length > 0) {
    return {
      code: "VALIDATION",
      message:
        "sandbox-docker does not support SandboxProfile.filesystem.denyWrite; use @koi/sandbox-os or compose a deny layer",
      retryable: false,
      context: { unsupported: "denyWrite" },
    };
  }
  if (fs.defaultReadAccess !== undefined && fs.defaultReadAccess !== "open") {
    return {
      code: "VALIDATION",
      message:
        "sandbox-docker only supports defaultReadAccess: open (allow-list of bind mounts); use @koi/sandbox-os for deny-by-default semantics",
      retryable: false,
    };
  }
  return undefined;
}

/** Build the list of Docker bind-mount strings from a filesystem policy. */
function buildBinds(profile: SandboxProfile): readonly string[] {
  // `let` justified: binds is built incrementally from multiple policy sources
  const binds: string[] = [];

  const { allowRead, allowWrite } = profile.filesystem;

  for (const p of allowRead ?? []) {
    binds.push(`${p}:${p}:ro`);
  }
  for (const p of allowWrite ?? []) {
    binds.push(`${p}:${p}:rw`);
  }

  for (const mount of profile.nexusMounts ?? []) {
    // nexusUrl, apiKey, agentId are credentials/config for the FUSE daemon —
    // not translated here. We map only the host↔container path binding.
    binds.push(`${mount.mountPath}:${mount.mountPath}:rw`);
  }

  return binds;
}

export function mapProfileToDockerOpts(
  profile: SandboxProfile,
  image: string,
): Result<ProfileMapping, KoiError> {
  const validationError = validateProfileForDocker(profile);
  if (validationError !== undefined) return { ok: false, error: validationError };

  const { networkMode } = resolveDockerNetwork(profile.network);
  const binds = buildBinds(profile);

  // Enable read-only rootfs when allow-list filesystem semantics are in use:
  // if allowWrite is set, the caller has opted into explicit-allow semantics and
  // expects only the listed paths to be writable. Making rootfs read-only enforces
  // this contract. /tmp is mounted as tmpfs for scratch space (Docker convention).
  // We also enable it when only allowRead is set — allow-list implies intent.
  const hasAllowList =
    (profile.filesystem.allowWrite !== undefined && profile.filesystem.allowWrite.length > 0) ||
    (profile.filesystem.allowRead !== undefined && profile.filesystem.allowRead.length > 0);

  const opts: DockerCreateOpts = {
    image,
    networkMode,
    ...(profile.resources.maxPids !== undefined ? { pidsLimit: profile.resources.maxPids } : {}),
    ...(profile.resources.maxMemoryMb !== undefined
      ? { memoryMb: profile.resources.maxMemoryMb }
      : {}),
    ...(profile.env !== undefined ? { env: profile.env } : {}),
    ...(binds.length > 0 ? { binds } : {}),
    ...(hasAllowList ? { readOnlyRoot: true, tmpfsMounts: ["/tmp"] } : {}),
  };
  return { ok: true, value: { opts, networkMode } };
}
