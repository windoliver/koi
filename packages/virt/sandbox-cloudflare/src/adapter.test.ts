import { describe, expect, mock, test } from "bun:test";
import { createCloudflareAdapter } from "./adapter.js";
import type { CfSdkSandbox, CloudflareClient } from "./types.js";

function createMockSdk(): CfSdkSandbox {
  return {
    commands: { run: mock(() => Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" })) },
    files: { read: mock(() => Promise.resolve("")), write: mock(() => Promise.resolve()) },
    close: mock(() => Promise.resolve()),
  };
}

function createMockClient(sdk?: CfSdkSandbox): CloudflareClient {
  return { createSandbox: mock(() => Promise.resolve(sdk ?? createMockSdk())) };
}

describe("createCloudflareAdapter", () => {
  test("returns ok with valid config", () => {
    const result = createCloudflareAdapter({ apiToken: "token", client: createMockClient() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("cloudflare");
  });

  test("returns error with missing token", () => {
    const original = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    try {
      expect(createCloudflareAdapter({}).ok).toBe(false);
    } finally {
      if (original !== undefined) process.env.CLOUDFLARE_API_TOKEN = original;
    }
  });

  test("returns error without injected client", () => {
    const result = createCloudflareAdapter({ apiToken: "token" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("client");
    }
  });

  test("create returns working instance", async () => {
    const sdk = createMockSdk();
    const result = createCloudflareAdapter({ apiToken: "token", client: createMockClient(sdk) });
    if (!result.ok) return;
    const instance = await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
    });
    expect((await instance.exec("echo", ["hi"])).exitCode).toBe(0);
    await instance.destroy();
  });

  test("passes r2Mounts to client", async () => {
    const client = createMockClient();
    const r2Mounts = [{ bucketName: "my-bucket", mountPath: "/mnt/r2" }];
    const result = createCloudflareAdapter({
      apiToken: "token",
      r2Mounts,
      client,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
    });

    expect(client.createSandbox).toHaveBeenCalledWith(expect.objectContaining({ r2Mounts }));
  });

  test("omits r2Mounts from opts when not configured", async () => {
    const client = createMockClient();
    const result = createCloudflareAdapter({ apiToken: "token", client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.value.create({
      filesystem: {},
      network: { allow: true },
      resources: {},
    });

    const calledWith = (client.createSandbox as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(calledWith).not.toHaveProperty("r2Mounts");
  });

  test("mounts nexus fuse when profile has nexusMounts", async () => {
    const sdk = createMockSdk();
    const client = createMockClient(sdk);
    const result = createCloudflareAdapter({ apiToken: "token", client });
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
    const result = createCloudflareAdapter({ apiToken: "token", client });
    if (!result.ok) return;

    await expect(
      result.value.create({
        filesystem: {},
        network: { allow: false },
        resources: {},
      }),
    ).rejects.toThrow("Cloudflare adapter cannot enforce");
  });
});
