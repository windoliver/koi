export { createDockerAdapter, type DockerSandboxAdapter } from "./adapter.js";
export { createDefaultDockerClient } from "./default-client.js";
export { detectDocker } from "./detect.js";
export {
  createFileScopeRegistry,
  createInMemoryScopeRegistry,
  defaultScopeRegistryDir,
  type ScopeRegistry,
} from "./scope-registry.js";
export {
  type DockerAdapterConfig,
  type DockerClient,
  type DockerContainer,
  type DockerContainerInfo,
  type DockerContainerState,
  type DockerCreateOpts,
  type DockerExecOpts,
  type DockerExecResult,
  type DockerNameConflictError,
  isDockerNameConflictError,
} from "./types.js";
