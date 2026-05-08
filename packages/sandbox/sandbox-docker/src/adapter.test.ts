import { describe, expect, test } from "bun:test";
import { createDockerAdapter } from "./adapter.js";
import type {
  DockerClient,
  DockerContainer,
  DockerContainerState,
  DockerCreateOpts,
} from "./types.js";

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

/** Build a fake DockerContainer with optional detach. */
function fakeContainer(id: string, withDetach = true): DockerContainer {
  return {
    id,
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    stop: async () => {},
    remove: async () => {},
    ...(withDetach ? { detach: async () => {} } : {}),
  };
}

/**
 * Build a persistence-capable DockerClient by overlaying find/inspect/start
 * onto a controllable container store.
 */
function persistentClient(opts: {
  readonly preexisting?: {
    readonly container: DockerContainer;
    readonly state: DockerContainerState;
  };
  readonly onCreate?: (createOpts: DockerCreateOpts) => DockerContainer;
}): {
  readonly client: DockerClient;
  readonly events: {
    readonly findCalls: number;
    readonly startCalls: string[];
    readonly createCalls: DockerCreateOpts[];
  };
} {
  const events = {
    findCalls: 0,
    startCalls: [] as string[],
    createCalls: [] as DockerCreateOpts[],
  };
  const client: DockerClient = {
    createContainer: async (createOpts: DockerCreateOpts): Promise<DockerContainer> => {
      events.createCalls.push(createOpts);
      return opts.onCreate?.(createOpts) ?? fakeContainer(`new-${events.createCalls.length}`);
    },
    findContainer: async () => {
      events.findCalls += 1;
      return opts.preexisting?.container;
    },
    inspectState: async () => opts.preexisting?.state ?? "unknown",
    startContainer: async (id: string) => {
      events.startCalls.push(id);
    },
  };
  return { client, events };
}

describe("createDockerAdapter", () => {
  test("returns a SandboxAdapter named 'docker' when client provided", async () => {
    const r = await createDockerAdapter({ client: stubClient });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("docker");
  });

  test("create(profile) yields a SandboxInstance with working exec", async () => {
    const r = await createDockerAdapter({ client: stubClient });
    if (!r.ok) throw new Error("setup failed");
    const inst = await r.value.create({
      filesystem: { defaultReadAccess: "open" },
      network: { allow: false },
      resources: {},
    });
    const out = await inst.exec("echo", ["ok"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("ok");
  });

  // Fail-closed: when no client + probe returns unavailable → ok: false, UNAVAILABLE
  test("returns ok: false with UNAVAILABLE when detectDocker probe fails", async () => {
    const unavailableProbe = async (): Promise<number> => 1;
    const r = await createDockerAdapter({ probe: unavailableProbe });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("UNAVAILABLE");
  });

  // Fail-closed: detectDocker probe throws → ok: false, UNAVAILABLE
  test("returns ok: false with UNAVAILABLE when probe throws", async () => {
    const throwingProbe = async (): Promise<number> => {
      throw new Error("cannot reach docker");
    };
    const r = await createDockerAdapter({ probe: throwingProbe });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("UNAVAILABLE");
  });

  // Slow path: probe succeeds → build adapter with default client
  test("returns ok: true with default client when probe succeeds", async () => {
    const successProbe = async (): Promise<number> => 0;
    const r = await createDockerAdapter({ probe: successProbe });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(`Expected ok, got: ${r.error.message}`);
    expect(r.value.name).toBe("docker");
  });

  // Explicit client is preserved (sync path — no probe called)
  test("explicit client skips probe and returns ok: true", async () => {
    // If probe were called, it would fail — but explicit client skips probe.
    const failProbe = async (): Promise<number> => {
      throw new Error("should not be called");
    };
    const r = await createDockerAdapter({ client: stubClient, probe: failProbe });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("Expected ok");
    expect(r.value.name).toBe("docker");
  });

  // Fix 2 (socketPath): when socketPath configured + probe succeeds, adapter is built
  test("builds adapter when socketPath configured and probe succeeds", async () => {
    // Provide a successful probe (probe receives socketPath-aware default probe under the hood,
    // but for this test we use an explicit probe to avoid spawning real docker).
    const successProbe = async (): Promise<number> => 0;
    const r = await createDockerAdapter({
      socketPath: "/custom/docker.sock",
      probe: successProbe,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(`Expected ok, got: ${r.error.message}`);
    expect(r.value.name).toBe("docker");
  });

  // Fix 2 (socketPath): when socketPath configured + probe fails, returns UNAVAILABLE
  test("returns UNAVAILABLE when socketPath configured but probe fails", async () => {
    const failProbe = async (): Promise<number> => 1;
    const r = await createDockerAdapter({
      socketPath: "/custom/docker.sock",
      probe: failProbe,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("UNAVAILABLE");
  });

  // Fix 2: profile with denyRead → create() rejects with helpful error
  test("create(profile) throws when profile has denyRead (unsupported Docker semantics)", async () => {
    const r = await createDockerAdapter({ client: stubClient });
    if (!r.ok) throw new Error("setup failed");
    const profileWithDenyRead = {
      filesystem: { defaultReadAccess: "open" as const, denyRead: ["/etc"] },
      network: { allow: false },
      resources: {},
    };
    await expect(r.value.create(profileWithDenyRead)).rejects.toThrow("Invalid profile");
  });

  // Persistence: minimal client (no find/inspect/start) → no findOrCreate, no persistence cap.
  test("minimal DockerClient (no persistence triple) omits findOrCreate and persistence capability", async () => {
    const r = await createDockerAdapter({ client: stubClient });
    if (!r.ok) throw new Error("setup failed");
    expect(r.value.findOrCreate).toBeUndefined();
    expect(r.value.capabilities?.supports.has("persistence")).toBe(false);
  });

  // Persistence: capable client → findOrCreate exposed, persistence cap declared.
  test("persistence-capable DockerClient declares persistence and exposes findOrCreate", async () => {
    const { client } = persistentClient({});
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    expect(typeof r.value.findOrCreate).toBe("function");
    expect(r.value.capabilities?.supports.has("persistence")).toBe(true);
  });

  const PROFILE = {
    filesystem: { defaultReadAccess: "open" as const },
    network: { allow: false },
    resources: {},
  };

  // Persistence: existing running container is reused — no createContainer, no startContainer.
  test("findOrCreate reuses an existing running container without create/start", async () => {
    const existing = fakeContainer("existing-running");
    const { client, events } = persistentClient({
      preexisting: { container: existing, state: "running" },
    });
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    const inst = await r.value.findOrCreate("scope-A", PROFILE);
    expect(events.createCalls.length).toBe(0);
    expect(events.startCalls.length).toBe(0);
    // L0 contract: persistent-capable instance exposes detach.
    expect(typeof inst.detach).toBe("function");
  });

  // Persistence: stopped container is started, not recreated.
  test("findOrCreate restarts a stopped container instead of creating a new one", async () => {
    const existing = fakeContainer("existing-stopped");
    const { client, events } = persistentClient({
      preexisting: { container: existing, state: "stopped" },
    });
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await r.value.findOrCreate("scope-B", PROFILE);
    expect(events.startCalls).toEqual(["existing-stopped"]);
    expect(events.createCalls.length).toBe(0);
  });

  // Persistence: exited containers are restarted.
  test("findOrCreate restarts an exited container", async () => {
    const existing = fakeContainer("existing-exited");
    const { client, events } = persistentClient({
      preexisting: { container: existing, state: "exited" },
    });
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await r.value.findOrCreate("scope-C", PROFILE);
    expect(events.startCalls).toEqual(["existing-exited"]);
    expect(events.createCalls.length).toBe(0);
  });

  // Persistence: dead containers are abandoned and a fresh one is created with the scope label.
  test("findOrCreate creates a fresh labeled container when existing one is dead", async () => {
    const dead = fakeContainer("zombie");
    const { client, events } = persistentClient({
      preexisting: { container: dead, state: "dead" },
    });
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await r.value.findOrCreate("scope-D", PROFILE);
    expect(events.startCalls.length).toBe(0);
    expect(events.createCalls.length).toBe(1);
    expect(events.createCalls[0]?.labels?.["koi.sandbox.scope"]).toBe("scope-D");
  });

  // Persistence: no container matches → fresh container with scope label is created.
  test("findOrCreate creates a fresh labeled container when none exists", async () => {
    const { client, events } = persistentClient({});
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await r.value.findOrCreate("scope-E", PROFILE);
    expect(events.findCalls).toBe(1);
    expect(events.createCalls.length).toBe(1);
    expect(events.createCalls[0]?.labels?.["koi.sandbox.scope"]).toBe("scope-E");
  });

  // Persistence: profile with denyRead is still rejected on the findOrCreate path.
  test("findOrCreate throws on invalid profile (denyRead is unsupported)", async () => {
    const { client } = persistentClient({});
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    const bad = {
      filesystem: { defaultReadAccess: "open" as const, denyRead: ["/etc"] },
      network: { allow: false },
      resources: {},
    };
    await expect(r.value.findOrCreate("scope-F", bad)).rejects.toThrow("Invalid profile");
  });
});
