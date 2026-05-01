// packages/sandbox/sandbox-conformance/src/__tests__/conformance.test.ts
import type {
  AdapterCapabilities,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { describeSandboxConformance } from "../index.js";

const caps: AdapterCapabilities = {
  supports: new Set(["exec", "copy-files"]),
  priority: 0,
};

function fakeInstance(): SandboxInstance {
  return {
    exec: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      oomKilled: false,
    }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    destroy: async () => {},
  };
}

const adapter: SandboxAdapter = {
  name: "fake",
  capabilities: caps,
  version: "0.0.0",
  create: async () => fakeInstance(),
};

const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: false },
  resources: {},
};

describeSandboxConformance(
  "fake-umbrella",
  () => adapter,
  () => profile,
);
