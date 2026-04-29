/**
 * Maps a platform-agnostic SandboxProfile to DockerCreateOpts.
 *
 * Translation coverage:
 *   - network:   fully translated (none / bridge)
 *   - resources: maxPids → --pids-limit, maxMemoryMb → --memory
 *   - env:       forwarded directly
 *   - filesystem.allowRead  → bind mount :ro
 *   - filesystem.allowWrite → bind mount :rw
 *   - nexusMounts → bind mount source:mountPath (rw)
 *
 * NOT translated (requires OS-level or Nexus FUSE implementation):
 *   - filesystem.defaultReadAccess / denyRead / denyWrite — Docker has no
 *     fine-grained path-deny; use a restrictive base image instead.
 *   - NexusFuseMount.nexusUrl / apiKey / agentId — credentials are out of
 *     scope for this adapter; Nexus FUSE daemon must be running on the host
 *     and the mount point must already exist before container creation.
 */

import type { SandboxProfile } from "@koi/core";
import { resolveDockerNetwork } from "./network.js";
import type { DockerCreateOpts } from "./types.js";

export interface ProfileMapping {
  readonly opts: DockerCreateOpts;
  readonly networkMode: "none" | "bridge";
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

export function mapProfileToDockerOpts(profile: SandboxProfile, image: string): ProfileMapping {
  const { networkMode } = resolveDockerNetwork(profile.network);
  const binds = buildBinds(profile);

  const opts: DockerCreateOpts = {
    image,
    networkMode,
    ...(profile.resources.maxPids !== undefined ? { pidsLimit: profile.resources.maxPids } : {}),
    ...(profile.resources.maxMemoryMb !== undefined
      ? { memoryMb: profile.resources.maxMemoryMb }
      : {}),
    ...(profile.env !== undefined ? { env: profile.env } : {}),
    ...(binds.length > 0 ? { binds } : {}),
  };
  return { opts, networkMode };
}
