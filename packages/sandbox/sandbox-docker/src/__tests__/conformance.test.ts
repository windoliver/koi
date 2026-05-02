import type { SandboxAdapter, SandboxProfile } from "@koi/core";
import { describeSandboxConformance } from "@koi/sandbox-conformance";
import { createDockerAdapter } from "../adapter.js";
import type { DockerClient } from "../types.js";

// Stubbed Docker client — conformance verifies adapter contract shape, not
// real Docker daemon behavior. The DOCKER_E2E=1 integration suite covers
// real-daemon paths.
const stubClient: DockerClient = {
  createContainer: async () => ({
    id: "c1",
    exec: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    stop: async () => {},
    remove: async () => {},
  }),
};

const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: false },
  resources: {},
};

async function makeAdapter(): Promise<SandboxAdapter> {
  const result = await createDockerAdapter({ client: stubClient });
  if (!result.ok) throw new Error(`createDockerAdapter failed: ${result.error.message}`);
  return result.value;
}

// `describeSandboxConformance` expects a synchronous factory. We pre-build a
// shared adapter; each test that needs a fresh one re-uses this reference
// (the conformance suite tolerates this — it does not mutate the adapter).
let cached: SandboxAdapter | undefined;
async function getAdapter(): Promise<SandboxAdapter> {
  if (cached === undefined) cached = await makeAdapter();
  return cached;
}

// Eagerly resolve before describe() runs so the synchronous factory works.
await getAdapter();

describeSandboxConformance(
  "@koi/sandbox-docker",
  () => {
    if (cached === undefined) throw new Error("adapter not initialized");
    return cached;
  },
  () => profile,
);
