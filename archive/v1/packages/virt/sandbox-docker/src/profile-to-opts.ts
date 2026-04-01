/**
 * SandboxProfile → DockerCreateOpts translation.
 *
 * Maps the platform-agnostic SandboxProfile into Docker-specific
 * container creation options.
 */

import type { SandboxProfile } from "@koi/core";
import type { DockerNetworkConfig } from "./network.js";
import { resolveNetworkConfig } from "./network.js";
import type { DockerCreateOpts } from "./types.js";

const MB_TO_BYTES = 1024 * 1024;

/** Resolved profile with network config for use by the instance. */
export interface ResolvedDockerProfile {
  readonly opts: DockerCreateOpts;
  readonly networkConfig: DockerNetworkConfig;
}

/**
 * Convert a SandboxProfile into Docker container creation options.
 *
 * Maps:
 * - filesystem.allowRead → ":ro" bind mounts
 * - filesystem.allowWrite → ":rw" bind mounts (deduped with read)
 * - resources.maxMemoryMb → memory (bytes)
 * - resources.maxPids → pidsLimit
 * - env → passed through
 * - network → via resolveNetworkConfig()
 */
export function profileToDockerOpts(profile: SandboxProfile, image: string): ResolvedDockerProfile {
  const networkConfig = resolveNetworkConfig(profile.network);
  const binds = buildBindMounts(profile);

  const opts: DockerCreateOpts = {
    image,
    networkMode: networkConfig.networkMode,
    ...(profile.env !== undefined ? { env: profile.env } : {}),
    ...(profile.resources.maxMemoryMb !== undefined
      ? { memory: profile.resources.maxMemoryMb * MB_TO_BYTES }
      : {}),
    ...(profile.resources.maxPids !== undefined ? { pidsLimit: profile.resources.maxPids } : {}),
    ...(binds.length > 0 ? { binds } : {}),
    ...(networkConfig.capAdd.length > 0 ? { capAdd: networkConfig.capAdd } : {}),
  };

  return { opts, networkConfig };
}

/**
 * Build bind mount strings from filesystem policy.
 * Write paths take precedence over read paths (deduped).
 */
function buildBindMounts(profile: SandboxProfile): readonly string[] {
  const fs = profile.filesystem;
  const writePaths = new Set(fs.allowWrite?.map((p) => p.replace(/\*.*$/, "")) ?? []);

  const readMounts = (fs.allowRead ?? [])
    .map((p) => p.replace(/\*.*$/, ""))
    .filter((p) => p !== "" && !writePaths.has(p))
    .map((p) => `${p}:${p}:ro`);

  const writeMounts = [...writePaths].filter((p) => p !== "").map((p) => `${p}:${p}:rw`);

  return [...readMounts, ...writeMounts];
}
