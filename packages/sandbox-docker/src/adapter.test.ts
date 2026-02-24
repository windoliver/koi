import { describe, expect, mock, test } from "bun:test";
import { createDockerAdapter } from "./adapter.js";
import type { DockerClient, DockerContainer } from "./types.js";

function createMockContainer(): DockerContainer {
  return {
    id: "test-container-123",
    exec: mock(() => Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" })),
    readFile: mock(() => Promise.resolve("")),
    writeFile: mock(() => Promise.resolve()),
    stop: mock(() => Promise.resolve()),
    remove: mock(() => Promise.resolve()),
  };
}

function createMockClient(container?: DockerContainer): DockerClient {
  return {
    createContainer: mock(() => Promise.resolve(container ?? createMockContainer())),
  };
}

describe("createDockerAdapter", () => {
  test("returns ok with default config", () => {
    const client = createMockClient();
    const result = createDockerAdapter({ client });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("docker");
    }
  });

  test("returns error with empty image", () => {
    const result = createDockerAdapter({ image: "" });
    expect(result.ok).toBe(false);
  });

  test("returns error with empty socketPath", () => {
    const result = createDockerAdapter({ socketPath: "" });
    expect(result.ok).toBe(false);
  });

  test("create returns a working SandboxInstance", async () => {
    const container = createMockContainer();
    const client = createMockClient(container);
    const result = createDockerAdapter({ client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const instance = await result.value.create({
      tier: "sandbox",
      filesystem: { allowRead: ["/tmp"] },
      network: { allow: false },
      resources: { maxMemoryMb: 256, timeoutMs: 10000 },
    });

    const execResult = await instance.exec("echo", ["hello"]);
    expect(execResult.exitCode).toBe(0);

    await instance.destroy();
    expect(container.stop).toHaveBeenCalledTimes(1);
    expect(container.remove).toHaveBeenCalledTimes(1);
  });

  test("passes profile-derived opts to client.createContainer", async () => {
    const client = createMockClient();
    const result = createDockerAdapter({ image: "node:20", client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.value.create({
      tier: "sandbox",
      filesystem: {},
      network: { allow: true },
      resources: { maxMemoryMb: 512 },
    });

    expect(client.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "node:20",
        networkMode: "bridge",
        memory: 512 * 1024 * 1024,
      }),
    );
  });

  test("enforces network=none for disallowed network", async () => {
    const client = createMockClient();
    const result = createDockerAdapter({ client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.value.create({
      tier: "sandbox",
      filesystem: {},
      network: { allow: false },
      resources: {},
    });

    expect(client.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ networkMode: "none" }),
    );
  });

  test("adds CAP_NET_ADMIN for allowedHosts", async () => {
    const client = createMockClient();
    const result = createDockerAdapter({ client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.value.create({
      tier: "sandbox",
      filesystem: {},
      network: { allow: true, allowedHosts: ["api.example.com"] },
      resources: {},
    });

    expect(client.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        networkMode: "bridge",
        capAdd: ["NET_ADMIN"],
      }),
    );
  });

  test("throws without injected client", async () => {
    const result = createDockerAdapter({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await expect(
      result.value.create({
        tier: "sandbox",
        filesystem: {},
        network: { allow: false },
        resources: {},
      }),
    ).rejects.toThrow("Docker client not provided");
  });
});
