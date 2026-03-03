/**
 * @koi/sandbox-docker — Docker container sandbox adapter (Layer 2)
 *
 * Provides Docker-based sandbox instances for local code execution
 * in isolated containers. The only backend that works offline without
 * API keys. Enforces NetworkPolicy.allowedHosts via iptables.
 */

export { createDockerAdapter } from "./adapter.js";
export { createDockerInstance } from "./instance.js";
export type { DockerNetworkConfig } from "./network.js";
export { resolveNetworkConfig } from "./network.js";
export type { ResolvedDockerProfile } from "./profile-to-opts.js";
export { profileToDockerOpts } from "./profile-to-opts.js";
export type {
  DockerAdapterConfig,
  DockerClient,
  DockerContainer,
  DockerCreateOpts,
  DockerExecOpts,
  DockerExecResult,
} from "./types.js";
export type { ValidatedDockerConfig } from "./validate.js";
export { validateDockerConfig } from "./validate.js";
