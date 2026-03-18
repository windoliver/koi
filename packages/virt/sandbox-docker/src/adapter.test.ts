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
    const result = createDockerAdapter({ image: "", client: createMockClient() });
    expect(result.ok).toBe(false);
  });

  test("returns error with empty socketPath", () => {
    const result = createDockerAdapter({ socketPath: "", client: createMockClient() });
    expect(result.ok).toBe(false);
  });

  test("returns error without injected client", () => {
    const result = createDockerAdapter({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("client");
    }
  });

  test("create returns a working SandboxInstance", async () => {
    const container = createMockContainer();
    const client = createMockClient(container);
    const result = createDockerAdapter({ client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const instance = await result.value.create({
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

  // ---- findOrCreate persistence tests ----

  test("findOrCreate is absent when client lacks find/inspect/start", () => {
    const client = createMockClient();
    const result = createDockerAdapter({ client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findOrCreate).toBeUndefined();
  });

  test("findOrCreate reuses running container", async () => {
    const container = createMockContainer();
    const client: DockerClient = {
      createContainer: mock(() => Promise.resolve(createMockContainer())),
      findContainer: mock(() => Promise.resolve(container)),
      inspectState: mock(() => Promise.resolve("running")),
      startContainer: mock(() => Promise.resolve()),
    };
    const result = createDockerAdapter({ client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findOrCreate).toBeDefined();

    const instance = await result.value.findOrCreate?.("my-scope", {
      filesystem: {},
      network: { allow: false },
      resources: {},
    });

    expect(client.findContainer).toHaveBeenCalledWith({ "koi.sandbox.scope": "my-scope" });
    expect(client.startContainer).not.toHaveBeenCalled();
    expect(client.createContainer).not.toHaveBeenCalled();
    expect(instance).toBeDefined();
    expect(instance.detach).toBeDefined();
  });

  test("findOrCreate restarts stopped container", async () => {
    const container = createMockContainer();
    const client: DockerClient = {
      createContainer: mock(() => Promise.resolve(createMockContainer())),
      findContainer: mock(() => Promise.resolve(container)),
      inspectState: mock(() => Promise.resolve("exited")),
      startContainer: mock(() => Promise.resolve()),
    };
    const result = createDockerAdapter({ client });
    if (!result.ok) return;

    await result.value.findOrCreate?.("my-scope", {
      filesystem: {},
      network: { allow: false },
      resources: {},
    });

    expect(client.startContainer).toHaveBeenCalledWith(container.id);
    expect(client.createContainer).not.toHaveBeenCalled();
  });

  test("findOrCreate creates fresh when container not found", async () => {
    const newContainer = createMockContainer();
    const client: DockerClient = {
      createContainer: mock(() => Promise.resolve(newContainer)),
      findContainer: mock(() => Promise.resolve(undefined)),
      inspectState: mock(() => Promise.resolve("")),
      startContainer: mock(() => Promise.resolve()),
    };
    const result = createDockerAdapter({ client });
    if (!result.ok) return;

    await result.value.findOrCreate?.("my-scope", {
      filesystem: {},
      network: { allow: false },
      resources: {},
    });

    expect(client.createContainer).toHaveBeenCalledTimes(1);
    const callArgs = (client.createContainer as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.labels).toMatchObject({ "koi.sandbox.scope": "my-scope" });
  });

  test("findOrCreate creates fresh when container is dead", async () => {
    const deadContainer = createMockContainer();
    const client: DockerClient = {
      createContainer: mock(() => Promise.resolve(createMockContainer())),
      findContainer: mock(() => Promise.resolve(deadContainer)),
      inspectState: mock(() => Promise.resolve("dead")),
      startContainer: mock(() => Promise.resolve()),
    };
    const result = createDockerAdapter({ client });
    if (!result.ok) return;

    await result.value.findOrCreate?.("my-scope", {
      filesystem: {},
      network: { allow: false },
      resources: {},
    });

    expect(client.createContainer).toHaveBeenCalledTimes(1);
  });

  test("detach stops container without removing", async () => {
    const container = createMockContainer();
    const client: DockerClient = {
      createContainer: mock(() => Promise.resolve(createMockContainer())),
      findContainer: mock(() => Promise.resolve(container)),
      inspectState: mock(() => Promise.resolve("running")),
      startContainer: mock(() => Promise.resolve()),
    };
    const result = createDockerAdapter({ client });
    if (!result.ok) return;

    const instance = await result.value.findOrCreate?.("my-scope", {
      filesystem: {},
      network: { allow: false },
      resources: {},
    });

    expect(instance.detach).toBeDefined();
    await instance.detach?.();

    expect(container.stop).toHaveBeenCalledTimes(1);
    expect(container.remove).not.toHaveBeenCalled();
  });
});
