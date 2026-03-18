import { describe, expect, mock, test } from "bun:test";
import { createE2bAdapter } from "./adapter.js";
import type { E2bClient, E2bSdkSandbox } from "./types.js";

function createMockSdk(): E2bSdkSandbox {
  return {
    commands: {
      run: mock(() => Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" })),
    },
    files: {
      read: mock(() => Promise.resolve("")),
      write: mock(() => Promise.resolve()),
    },
    kill: mock(() => Promise.resolve()),
  };
}

function createMockClient(sdk?: E2bSdkSandbox): E2bClient {
  return {
    createSandbox: mock(() => Promise.resolve(sdk ?? createMockSdk())),
  };
}

describe("createE2bAdapter", () => {
  test("returns ok with valid config", () => {
    const client = createMockClient();
    const result = createE2bAdapter({ apiKey: "test-key", client });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("e2b");
    }
  });

  test("returns error with invalid config", () => {
    const original = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
    try {
      const result = createE2bAdapter({});
      expect(result.ok).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env.E2B_API_KEY = original;
      }
    }
  });

  test("returns error without injected client", () => {
    const result = createE2bAdapter({ apiKey: "test-key" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("client");
    }
  });

  test("create returns a working SandboxInstance", async () => {
    const sdk = createMockSdk();
    const client = createMockClient(sdk);
    const result = createE2bAdapter({ apiKey: "test-key", client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const instance = await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: { timeoutMs: 10000 },
    });

    const execResult = await instance.exec("echo", ["hello"]);
    expect(execResult.exitCode).toBe(0);

    await instance.destroy();
    expect(sdk.kill).toHaveBeenCalledTimes(1);
  });

  test("passes template to client", async () => {
    const client = createMockClient();
    const result = createE2bAdapter({
      apiKey: "test-key",
      template: "custom-template",
      client,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
    });

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ template: "custom-template" }),
    );
  });

  test("passes mounts to client", async () => {
    const client = createMockClient();
    const mounts = [{ type: "s3" as const, bucket: "b", mountPath: "/mnt/data", credentials: {} }];
    const result = createE2bAdapter({ apiKey: "test-key", mounts, client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
    });

    expect(client.createSandbox).toHaveBeenCalledWith(expect.objectContaining({ mounts }));
  });

  test("omits mounts from opts when not configured", async () => {
    const client = createMockClient();
    const result = createE2bAdapter({ apiKey: "test-key", client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
    });

    const calledWith = (client.createSandbox as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(calledWith).not.toHaveProperty("mounts");
  });

  test("mounts nexus fuse when profile has nexusMounts", async () => {
    const sdk = createMockSdk();
    const client = createMockClient(sdk);
    const result = createE2bAdapter({ apiKey: "test-key", client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const instance = await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
      nexusMounts: [{ nexusUrl: "https://nexus.test", apiKey: "nk", mountPath: "/mnt/nexus" }],
    });

    // mkdir, nexus-fuse, ls — 3 calls from mountNexusFuse
    expect(sdk.commands.run).toHaveBeenCalledTimes(3);
    expect(instance).toBeDefined();
  });

  test("throws on unsupported profile policies", async () => {
    const client = createMockClient();
    const result = createE2bAdapter({ apiKey: "test-key", client });
    if (!result.ok) return;

    await expect(
      result.value.create({
        filesystem: { denyRead: ["/etc/secrets"] },
        network: { allow: false },
        resources: { maxMemoryMb: 256 },
      }),
    ).rejects.toThrow("E2B adapter cannot enforce");
  });

  // ---- findOrCreate persistence tests ----

  test("findOrCreate is absent when client lacks resumeSandbox", () => {
    const client = createMockClient();
    const result = createE2bAdapter({ apiKey: "test-key", client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findOrCreate).toBeUndefined();
  });

  test("findOrCreate resumes sandbox by scope", async () => {
    const resumedSdk = createMockSdk();
    const client: E2bClient = {
      createSandbox: mock(() => Promise.resolve(createMockSdk())),
      resumeSandbox: mock(() => Promise.resolve(resumedSdk)),
    };
    const result = createE2bAdapter({ apiKey: "test-key", client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findOrCreate).toBeDefined();

    const instance = await result.value.findOrCreate?.("my-scope", {
      filesystem: {},
      network: { allow: true },
      resources: {},
    });

    expect(client.resumeSandbox).toHaveBeenCalledWith("my-scope");
    expect(client.createSandbox).not.toHaveBeenCalled();
    expect(instance).toBeDefined();
  });

  test("findOrCreate creates fresh on resume failure", async () => {
    const freshSdk = createMockSdk();
    const client: E2bClient = {
      createSandbox: mock(() => Promise.resolve(freshSdk)),
      resumeSandbox: mock(() => Promise.reject(new Error("not found"))),
    };
    const result = createE2bAdapter({ apiKey: "test-key", client });
    if (!result.ok) return;

    await result.value.findOrCreate?.("my-scope", {
      filesystem: {},
      network: { allow: true },
      resources: {},
    });

    expect(client.createSandbox).toHaveBeenCalledTimes(1);
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { "koi.sandbox.scope": "my-scope" } }),
    );
  });

  test("detach calls sdk.pause when available", async () => {
    const pauseFn = mock(() => Promise.resolve());
    const sdk: E2bSdkSandbox = { ...createMockSdk(), pause: pauseFn };
    const client = createMockClient(sdk);
    const result = createE2bAdapter({ apiKey: "test-key", client });
    if (!result.ok) return;

    const instance = await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
    });

    expect(instance.detach).toBeDefined();
    await instance.detach?.();
    expect(pauseFn).toHaveBeenCalledTimes(1);
  });
});
