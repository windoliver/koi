import type { SandboxProfile } from "@koi/core";

export interface ResolvedDockerNetwork {
  readonly networkMode: "none" | "bridge";
}

export function resolveDockerNetwork(
  network: SandboxProfile["network"] | undefined,
): ResolvedDockerNetwork {
  if (network?.allow === true) {
    return { networkMode: "bridge" };
  }
  return { networkMode: "none" };
}
