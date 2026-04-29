import type { SandboxProfile } from "@koi/core";
import { resolveDockerNetwork } from "./network.js";
import type { DockerCreateOpts } from "./types.js";

export interface ProfileMapping {
  readonly opts: DockerCreateOpts;
  readonly networkMode: "none" | "bridge";
}

export function mapProfileToDockerOpts(profile: SandboxProfile, image: string): ProfileMapping {
  const { networkMode } = resolveDockerNetwork(profile.network);
  const opts: DockerCreateOpts = {
    image,
    networkMode,
    ...(profile.resources?.maxPids !== undefined ? { pidsLimit: profile.resources.maxPids } : {}),
    ...(profile.resources?.maxMemoryMb !== undefined
      ? { memoryMb: profile.resources.maxMemoryMb }
      : {}),
    ...(profile.env !== undefined ? { env: profile.env } : {}),
  };
  return { opts, networkMode };
}
