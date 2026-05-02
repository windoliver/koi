import { describe } from "bun:test";
import type {
  AdapterCapabilities,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { describeCapabilityHonestyConformance } from "../capability-honesty.js";

const caps: AdapterCapabilities = {
  supports: new Set(["exec", "copy-files", "spawn", "persistence"]),
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
    spawn: async () => ({
      pid: 1,
      stdin: { write: () => {}, end: () => {} },
      stdout: new ReadableStream({ start: (c) => c.close() }),
      stderr: new ReadableStream({ start: (c) => c.close() }),
      exited: Promise.resolve(0),
      kill: () => {},
    }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    destroy: async () => {},
    detach: async () => {},
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
  findOrCreate: async () => fakeInstance(),
};

describe("capability-honesty conformance — fake adapter declaring all caps", () => {
  describeCapabilityHonestyConformance(
    () => adapter,
    () => profile,
  );
});
