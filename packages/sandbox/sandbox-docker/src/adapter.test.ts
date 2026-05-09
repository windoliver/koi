import { describe, expect, test } from "bun:test";
import { createDockerAdapter } from "./adapter.js";
import { computeProfileFingerprint } from "./fingerprint.js";
import { deriveScopeContainerName } from "./scope-name.js";
import {
  DOCKER_NAME_CONFLICT_CODE,
  type DockerClient,
  type DockerContainer,
  type DockerContainerState,
  type DockerCreateOpts,
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
 * onto a controllable container store. `preexisting.labels` defaults to a
 * fingerprint matching `PROFILE` so reuse paths succeed; tests override it to
 * simulate profile drift or absence.
 */
function persistentClient(opts: {
  readonly preexisting?: {
    readonly container: DockerContainer;
    readonly state: DockerContainerState;
    readonly labels?: Readonly<Record<string, string>>;
  };
  readonly onCreate?: (createOpts: DockerCreateOpts) => DockerContainer;
  readonly createDelayMs?: number;
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
      if (opts.createDelayMs !== undefined && opts.createDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.createDelayMs));
      }
      return opts.onCreate?.(createOpts) ?? fakeContainer(`new-${events.createCalls.length}`);
    },
    findContainer: async () => {
      events.findCalls += 1;
      return opts.preexisting?.container;
    },
    inspectContainer: async () =>
      opts.preexisting === undefined
        ? undefined
        : { state: opts.preexisting.state, labels: opts.preexisting.labels ?? {} },
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
  const PROFILE_HASH = computeProfileFingerprint(PROFILE, "ubuntu:22.04");
  const matchingLabels = { "koi.sandbox.profile-hash": PROFILE_HASH };

  // Persistence: existing running container is reused — no createContainer, no startContainer.
  test("findOrCreate reuses an existing running container without create/start", async () => {
    const existing = fakeContainer("existing-running");
    const { client, events } = persistentClient({
      preexisting: { container: existing, state: "running", labels: matchingLabels },
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
      preexisting: { container: existing, state: "stopped", labels: matchingLabels },
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
      preexisting: { container: existing, state: "exited", labels: matchingLabels },
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

  // Persistence (drift): existing container with a different profile-hash → fail closed.
  test("findOrCreate fails closed when stored profile-hash differs from requested", async () => {
    const existing = fakeContainer("drifted");
    const { client, events } = persistentClient({
      preexisting: {
        container: existing,
        state: "running",
        labels: { "koi.sandbox.profile-hash": "deadbeefdeadbeef" },
      },
    });
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await expect(r.value.findOrCreate("scope-G", PROFILE)).rejects.toThrow(/different profile/i);
    // Must not silently restart, recreate, or hand back the drifted container.
    expect(events.startCalls.length).toBe(0);
    expect(events.createCalls.length).toBe(0);
  });

  // Persistence (drift): existing container with NO profile-hash label is also a mismatch.
  test("findOrCreate fails closed when existing container has no profile-hash label", async () => {
    const existing = fakeContainer("legacy");
    const { client } = persistentClient({
      preexisting: { container: existing, state: "running", labels: {} },
    });
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await expect(r.value.findOrCreate("scope-H", PROFILE)).rejects.toThrow(/different profile/i);
  });

  // Persistence (fingerprint): fresh container is created with the profile-hash label set.
  test("findOrCreate stores profile-hash label on freshly created container", async () => {
    const { client, events } = persistentClient({});
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await r.value.findOrCreate("scope-I", PROFILE);
    expect(events.createCalls.length).toBe(1);
    expect(events.createCalls[0]?.labels?.["koi.sandbox.profile-hash"]).toBe(PROFILE_HASH);
  });

  // Persistence (race): concurrent findOrCreate(scope) calls must serialize so the
  // check-then-create window cannot fork one scope into two containers. Since the
  // mock starts with no preexisting container, naively both calls would observe
  // "no container" and both call createContainer; the per-scope serializer must
  // ensure only the first creates and the second reuses (find returns no preexisting
  // here either, so both can create — we assert serialized ordering instead).
  test("findOrCreate serializes per-scope calls (no interleaving)", async () => {
    // Track call order: first invocation should fully complete its create before
    // the second invocation begins its find.
    const order: string[] = [];
    const createCalls: DockerCreateOpts[] = [];
    let findCount = 0;
    const client: DockerClient = {
      createContainer: async (createOpts: DockerCreateOpts): Promise<DockerContainer> => {
        order.push(`create-start-${createCalls.length}`);
        createCalls.push(createOpts);
        await new Promise((res) => setTimeout(res, 20));
        order.push(`create-end-${createCalls.length - 1}`);
        return fakeContainer(`new-${createCalls.length}`);
      },
      findContainer: async () => {
        order.push(`find-${findCount}`);
        findCount += 1;
        return undefined;
      },
      inspectContainer: async () => undefined,
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");

    // Two concurrent calls for the SAME scope must serialize.
    const p1 = r.value.findOrCreate("scope-RACE", PROFILE);
    const p2 = r.value.findOrCreate("scope-RACE", PROFILE);
    await Promise.all([p1, p2]);

    // Expected serialized order: find-0 → create-start-0 → create-end-0 → find-1 → create-start-1 → create-end-1.
    expect(order).toEqual([
      "find-0",
      "create-start-0",
      "create-end-0",
      "find-1",
      "create-start-1",
      "create-end-1",
    ]);
  });

  // Persistence (race): concurrent findOrCreate for DIFFERENT scopes can interleave —
  // the per-scope serializer must not block unrelated work.
  test("findOrCreate does not serialize across distinct scopes", async () => {
    const order: string[] = [];
    let findCount = 0;
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => {
        order.push("create-start");
        await new Promise((res) => setTimeout(res, 20));
        order.push("create-end");
        return fakeContainer(`new-${order.length}`);
      },
      findContainer: async () => {
        const tag = `find-${findCount}`;
        findCount += 1;
        order.push(tag);
        return undefined;
      },
      inspectContainer: async () => undefined,
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");

    await Promise.all([
      r.value.findOrCreate("scope-X", PROFILE),
      r.value.findOrCreate("scope-Y", PROFILE),
    ]);

    // Both finds should happen before either create completes (interleaved).
    const findIdxs = order.map((s, i) => (s.startsWith("find-") ? i : -1)).filter((i) => i >= 0);
    const createEndIdxs = order.map((s, i) => (s === "create-end" ? i : -1)).filter((i) => i >= 0);
    expect(findIdxs.length).toBe(2);
    expect(createEndIdxs.length).toBe(2);
    // Both finds occur before the first create-end (proves interleaving).
    expect(Math.max(...findIdxs)).toBeLessThan(createEndIdxs[0] ?? Infinity);
  });

  // Persistence (cross-process race): when createContainer throws a name-conflict
  // error (another adapter won the race), findOrCreate must reattach to the
  // winner instead of bubbling the conflict.
  test("findOrCreate retries via findContainer when createContainer throws name conflict", async () => {
    const winner = fakeContainer("winner");
    let findCount = 0;
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => {
        // Simulate the daemon rejecting our --name because the rival already
        // claimed it between our find() and create().
        const e = Object.assign(new Error("name in use"), {
          code: DOCKER_NAME_CONFLICT_CODE,
        } as const);
        throw e;
      },
      findContainer: async () => {
        findCount += 1;
        // First find: nothing (we believed we needed to create). Second find
        // (after the conflict): the rival's container.
        return findCount === 1 ? undefined : winner;
      },
      inspectContainer: async () => ({
        state: "running",
        labels: { "koi.sandbox.profile-hash": PROFILE_HASH },
      }),
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    const inst = await r.value.findOrCreate("scope-RACE-X", PROFILE);
    // findContainer called twice: once before create, once after conflict.
    expect(findCount).toBe(2);
    expect(inst).toBeDefined();
  });

  // Persistence (cross-process race): name-conflict bubbles up if the conflict
  // is NOT a koi-managed scope container (no scope-labeled container exists
  // after the conflict). Prevents masking real squatters on the deterministic
  // name.
  test("findOrCreate surfaces name-conflict when no scope container is reachable after retry", async () => {
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => {
        const e = Object.assign(new Error("name in use"), {
          code: DOCKER_NAME_CONFLICT_CODE,
        } as const);
        throw e;
      },
      // Never find anything — simulates a squatter (non-koi container with the
      // same deterministic name).
      findContainer: async () => undefined,
      inspectContainer: async () => undefined,
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await expect(r.value.findOrCreate("scope-SQUAT", PROFILE)).rejects.toThrow(/name in use/);
  });

  // Persistence (cross-process race): the create call must include the
  // deterministic scope-derived container name so Docker enforces uniqueness.
  test("findOrCreate sends a deterministic --name (derived from scope) on create", async () => {
    const { client, events } = persistentClient({});
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await r.value.findOrCreate("scope-NAME", PROFILE);
    expect(events.createCalls.length).toBe(1);
    expect(events.createCalls[0]?.name).toBe(deriveScopeContainerName("scope-NAME"));
  });

  // Drift recovery: destroyScope removes a scoped container and unblocks reuse
  // with the new profile.
  test("destroyScope removes the scoped container and frees the scope", async () => {
    let stopped = 0;
    let removed = 0;
    const existing: DockerContainer = {
      id: "stale",
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      stop: async () => {
        stopped += 1;
      },
      remove: async () => {
        removed += 1;
      },
    };
    const { client } = persistentClient({
      preexisting: { container: existing, state: "running", labels: {} },
    });
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.destroyScope === undefined) throw new Error("destroyScope must exist");
    const wasDestroyed = await r.value.destroyScope("scope-DROP");
    expect(wasDestroyed).toBe(true);
    expect(stopped).toBe(1);
    expect(removed).toBe(1);
  });

  // destroyScope returns false (idempotent) when nothing matches.
  test("destroyScope returns false when no scoped container exists", async () => {
    const { client } = persistentClient({});
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.destroyScope === undefined) throw new Error("destroyScope must exist");
    const wasDestroyed = await r.value.destroyScope("scope-NONE");
    expect(wasDestroyed).toBe(false);
  });

  // destroyScope is omitted on minimal clients (no persistence triple).
  test("destroyScope is undefined when persistence is unavailable", async () => {
    const r = await createDockerAdapter({ client: stubClient });
    if (!r.ok) throw new Error("setup failed");
    expect(r.value.destroyScope).toBeUndefined();
  });

  // Drift error message points at the supported recovery method (destroyScope).
  test("findOrCreate drift error references destroyScope as the recovery path", async () => {
    const existing = fakeContainer("drifted");
    const { client } = persistentClient({
      preexisting: {
        container: existing,
        state: "running",
        labels: { "koi.sandbox.profile-hash": "deadbeefdeadbeef" },
      },
    });
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await expect(r.value.findOrCreate("scope-RECOVER", PROFILE)).rejects.toThrow(/destroyScope/);
  });

  // Persistence (race): if the first call rejects, the chain must not deadlock the second.
  test("findOrCreate keeps the per-scope chain alive after a rejection", async () => {
    let attempts = 0;
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => {
        attempts += 1;
        if (attempts === 1) throw new Error("synthetic create failure");
        return fakeContainer("recovered");
      },
      findContainer: async () => undefined,
      inspectContainer: async () => undefined,
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");

    const p1 = r.value.findOrCreate("scope-CHAIN", PROFILE);
    const p2 = r.value.findOrCreate("scope-CHAIN", PROFILE);
    await expect(p1).rejects.toThrow("synthetic create failure");
    const inst = await p2;
    expect(inst).toBeDefined();
    expect(attempts).toBe(2);
  });
});
