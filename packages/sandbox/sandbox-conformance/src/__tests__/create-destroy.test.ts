import { describe } from "bun:test";
import type {
  AdapterCapabilities,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { describeCreateDestroyConformance } from "../create-destroy.js";

const caps: AdapterCapabilities = {
  supports: new Set(["exec", "copy-files"]),
  priority: 0,
};

function fakeInstance(): SandboxInstance {
  let _destroyed = false;
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
    destroy: async () => {
      _destroyed = true;
    },
  };
}

const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: false },
  resources: {},
};

const adapter: SandboxAdapter = {
  name: "fake",
  capabilities: caps,
  version: "0.0.0",
  create: async () => fakeInstance(),
};

describe("create-destroy conformance — fake adapter", () => {
  describeCreateDestroyConformance(
    () => adapter,
    () => profile,
  );
});
