import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "@koi/core";
import { createSshAdapter } from "./adapter.js";
import type { SshClient, SshClientFactory, SshExecResult } from "./types.js";

interface StubControls {
  readonly execResult?: SshExecResult;
  readonly execError?: Error;
  readonly readFileBytes?: Uint8Array;
  readonly connectError?: Error;
}

let connectCallCount = 0;
let endCallCount = 0;
interface Trace {
  lastCommandLine: string | undefined;
}
const trace: Trace = { lastCommandLine: undefined };

function fakeFactory(controls: StubControls = {}): SshClientFactory {
  return {
    connect: async (_target) => {
      if (controls.connectError !== undefined) throw controls.connectError;
      connectCallCount++;
      const client: SshClient = {
        exec: async (line) => {
          trace.lastCommandLine = line;
          if (controls.execError !== undefined) throw controls.execError;
          return controls.execResult ?? { exitCode: 0, stdout: "ok\n", stderr: "" };
        },
        readFile: async (_path) => controls.readFileBytes ?? new Uint8Array([1, 2, 3]),
        writeFile: async (_path, _data) => {},
        end: async () => {
          endCallCount++;
        },
      };
      return client;
    },
  };
}

function profile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return {
    filesystem: { defaultReadAccess: "open" },
    network: { allow: true },
    resources: {},
    ssh: { host: "ex.com", user: "user", keyPath: "/tmp/k" },
    ...overrides,
  };
}

describe("createSshAdapter", () => {
  test("declares capabilities {exec, copy-files, persistence, network} priority 20", () => {
    const adapter = createSshAdapter({ clientFactory: fakeFactory() });
    const caps = adapter.capabilities;
    expect(caps).toBeDefined();
    if (caps === undefined) throw new Error("no caps");
    expect(caps.priority).toBe(20);
    expect([...caps.supports].sort()).toEqual(["copy-files", "exec", "network", "persistence"]);
  });

  test("create() opens an SSH connection and returns a SandboxInstance", async () => {
    connectCallCount = 0;
    const adapter = createSshAdapter({ clientFactory: fakeFactory() });
    const instance = await adapter.create(profile());
    expect(typeof instance.exec).toBe("function");
    expect(typeof instance.destroy).toBe("function");
    expect(connectCallCount).toBe(1);
    await instance.destroy();
  });

  test("create() rejects when profile.ssh is missing", async () => {
    const adapter = createSshAdapter({ clientFactory: fakeFactory() });
    const noSsh: SandboxProfile = {
      filesystem: { defaultReadAccess: "open" },
      network: { allow: true },
      resources: {},
    };
    await expect(adapter.create(noSsh)).rejects.toThrow(/profile\.ssh is required/);
  });

  test("instance.exec quotes args via composeCommandLine and returns the result", async () => {
    trace.lastCommandLine = undefined;
    const adapter = createSshAdapter({
      clientFactory: fakeFactory({
        execResult: { exitCode: 0, stdout: "hi", stderr: "" },
      }),
    });
    const instance = await adapter.create(profile());
    const r = await instance.exec("echo", ["hello world"]);
    expect(trace.lastCommandLine ?? "").toBe("'echo' 'hello world'");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hi");
    await instance.destroy();
  });

  test("instance.destroy is idempotent — second call is a no-op", async () => {
    endCallCount = 0;
    const adapter = createSshAdapter({ clientFactory: fakeFactory() });
    const instance = await adapter.create(profile());
    await instance.destroy();
    await instance.destroy();
    expect(endCallCount).toBe(1);
  });

  test("findOrCreate reuses the SSH connection per scope key", async () => {
    connectCallCount = 0;
    const adapter = createSshAdapter({ clientFactory: fakeFactory() });
    if (adapter.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    const i1 = await adapter.findOrCreate("scope-A", profile());
    const i2 = await adapter.findOrCreate("scope-A", profile());
    expect(connectCallCount).toBe(1);
    await i1.destroy(); // closes pool entry
    const i3 = await adapter.findOrCreate("scope-A", profile());
    expect(connectCallCount).toBe(2); // re-opened after destroy
    await i2.destroy(); // already closed connection — idempotent end
    await i3.destroy();
  });

  test("connect failure surfaces as a typed thrown Error with cause", async () => {
    const adapter = createSshAdapter({
      clientFactory: fakeFactory({ connectError: new Error("auth denied") }),
    });
    await expect(adapter.create(profile())).rejects.toThrow(/failed to connect/);
  });
});
