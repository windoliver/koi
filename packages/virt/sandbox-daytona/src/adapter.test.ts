import { describe, expect, mock, test } from "bun:test";
import { createDaytonaAdapter } from "./adapter.js";
import type { DaytonaClient, DaytonaSdkSandbox } from "./types.js";

function createMockSdk(): DaytonaSdkSandbox {
  return {
    commands: { run: mock(() => Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" })) },
    files: { read: mock(() => Promise.resolve("")), write: mock(() => Promise.resolve()) },
    close: mock(() => Promise.resolve()),
  };
}

function createMockClient(sdk?: DaytonaSdkSandbox): DaytonaClient {
  return { createSandbox: mock(() => Promise.resolve(sdk ?? createMockSdk())) };
}

describe("createDaytonaAdapter", () => {
  test("returns ok with valid config", () => {
    const result = createDaytonaAdapter({ apiKey: "key", client: createMockClient() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("daytona");
  });

  test("returns error with missing key", () => {
    const original = process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_KEY;
    try {
      expect(createDaytonaAdapter({}).ok).toBe(false);
    } finally {
      if (original !== undefined) process.env.DAYTONA_API_KEY = original;
    }
  });

  test("returns error without injected client", () => {
    const result = createDaytonaAdapter({ apiKey: "key" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("client");
    }
  });

  test("create returns working instance", async () => {
    const sdk = createMockSdk();
    const result = createDaytonaAdapter({ apiKey: "key", client: createMockClient(sdk) });
    if (!result.ok) return;
    const instance = await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
    });
    expect((await instance.exec("echo", ["hi"])).exitCode).toBe(0);
    await instance.destroy();
  });

  test("passes config to client", async () => {
    const client = createMockClient();
    const result = createDaytonaAdapter({
      apiKey: "key",
      apiUrl: "https://custom.api",
      target: "eu",
      client,
    });
    if (!result.ok) return;
    await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
    });
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "key", apiUrl: "https://custom.api", target: "eu" }),
    );
  });

  test("passes volumes to client", async () => {
    const client = createMockClient();
    const volumes = [{ volumeId: "vol-1", mountPath: "/mnt/data" }];
    const result = createDaytonaAdapter({
      apiKey: "key",
      volumes,
      client,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
    });

    expect(client.createSandbox).toHaveBeenCalledWith(expect.objectContaining({ volumes }));
  });

  test("omits volumes from opts when not configured", async () => {
    const client = createMockClient();
    const result = createDaytonaAdapter({ apiKey: "key", client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
    });

    const calledWith = (client.createSandbox as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(calledWith).not.toHaveProperty("volumes");
  });

  test("mounts nexus fuse when profile has nexusMounts", async () => {
    const sdk = createMockSdk();
    const client = createMockClient(sdk);
    const result = createDaytonaAdapter({ apiKey: "key", client });
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
    const result = createDaytonaAdapter({ apiKey: "key", client });
    if (!result.ok) return;

    await expect(
      result.value.create({
        filesystem: {},
        network: { allow: false },
        resources: {},
      }),
    ).rejects.toThrow("Daytona adapter cannot enforce");
  });

  // ---- findOrCreate persistence tests ----

  test("findOrCreate is absent when client lacks findSandbox", () => {
    const result = createDaytonaAdapter({ apiKey: "key", client: createMockClient() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findOrCreate).toBeUndefined();
  });

  test("findOrCreate reuses existing sandbox", async () => {
    const existingSdk = createMockSdk();
    const client: DaytonaClient = {
      createSandbox: mock(() => Promise.resolve(createMockSdk())),
      findSandbox: mock(() => Promise.resolve(existingSdk)),
    };
    const result = createDaytonaAdapter({ apiKey: "key", client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findOrCreate).toBeDefined();

    const instance = await result.value.findOrCreate?.("my-scope", {
      filesystem: {},
      network: { allow: true },
      resources: {},
    });

    expect(client.findSandbox).toHaveBeenCalledWith("my-scope");
    expect(client.createSandbox).not.toHaveBeenCalled();
    expect(instance).toBeDefined();
  });

  test("findOrCreate creates fresh with scope metadata when not found", async () => {
    const freshSdk = createMockSdk();
    const client: DaytonaClient = {
      createSandbox: mock(() => Promise.resolve(freshSdk)),
      findSandbox: mock(() => Promise.resolve(undefined)),
    };
    const result = createDaytonaAdapter({ apiKey: "key", client });
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

  test("detach calls sdk.close", async () => {
    const sdk = createMockSdk();
    const client = createMockClient(sdk);
    const result = createDaytonaAdapter({ apiKey: "key", client });
    if (!result.ok) return;

    const instance = await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
    });

    expect(instance.detach).toBeDefined();
    await instance.detach?.();
    expect(sdk.close).toHaveBeenCalledTimes(1);
  });
});
