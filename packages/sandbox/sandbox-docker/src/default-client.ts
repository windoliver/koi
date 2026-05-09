import { buildDockerEnv } from "./default-client-helpers.js";
import {
  createContainerOp,
  findContainersOp,
  inspectContainerOp,
  resolveImageIdOp,
  startContainerOp,
} from "./default-client-ops.js";
import type { DockerClient } from "./types.js";

export { buildDockerEnv } from "./default-client-helpers.js";

export interface DefaultDockerClientConfig {
  readonly socketPath?: string;
}

export function createDefaultDockerClient(config?: DefaultDockerClientConfig): DockerClient {
  const env = buildDockerEnv(config?.socketPath);
  return {
    createContainer: (opts) => createContainerOp(env, opts),
    findContainers: (labels) => findContainersOp(env, labels),
    resolveImageId: (imageRef) => resolveImageIdOp(env, imageRef),
    inspectContainer: (id) => inspectContainerOp(env, id),
    startContainer: (id) => startContainerOp(env, id),
  };
}
