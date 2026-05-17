import { describe, expect, mock, test } from "bun:test";
import { createDockerAdapter } from "./adapter.js";
import { computeProfileFingerprint } from "./fingerprint.js";
import { deriveScopeContainerName } from "./scope-name.js";
import { createInMemoryScopeRegistry, type ScopeRegistry } from "./scope-registry.js";
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
 * Build a persistence-capable DockerClient + ScopeRegistry pair. `preexisting`
 * pre-populates the registry with the container ID so the trust-check passes,
 * and supplies the labels (default: a fingerprint matching `PROFILE`) so
 * reuse paths succeed. Tests override `labels` to simulate profile drift or
 * `presentInRegistry: false` to simulate spoofed containers.
 */
function persistentClient(opts: {
  readonly preexisting?: {
    readonly container: DockerContainer;
    readonly state: DockerContainerState;
    readonly labels?: Readonly<Record<string, string>>;
    /** When false, do NOT record the container's ID in the registry — simulates a spoofed/foreign container. */
    readonly presentInRegistry?: boolean;
    readonly scope?: string;
  };
  readonly onCreate?: (createOpts: DockerCreateOpts) => DockerContainer;
  readonly createDelayMs?: number;
}): {
  readonly client: DockerClient;
  readonly scopeRegistry: ScopeRegistry;
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
  const scopeRegistry = createInMemoryScopeRegistry();
  if (
    opts.preexisting !== undefined &&
    opts.preexisting.presentInRegistry !== false &&
    opts.preexisting.scope !== undefined
  ) {
    // In-memory record is synchronous under the hood (Map.set); the Promise
    // resolves on the microtask queue. Fire-and-forget is safe here because
    // record() runs the side effect synchronously before yielding.
    void scopeRegistry.record(opts.preexisting.scope, opts.preexisting.container.id);
  }
  const client: DockerClient = {
    createContainer: async (createOpts: DockerCreateOpts): Promise<DockerContainer> => {
      events.createCalls.push(createOpts);
      if (opts.createDelayMs !== undefined && opts.createDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.createDelayMs));
      }
      return opts.onCreate?.(createOpts) ?? fakeContainer(`new-${events.createCalls.length}`);
    },
    findContainers: async () => {
      events.findCalls += 1;
      return opts.preexisting === undefined ? [] : [opts.preexisting.container];
    },
    inspectContainer: async () =>
      opts.preexisting === undefined
        ? undefined
        : { state: opts.preexisting.state, labels: opts.preexisting.labels ?? {} },
    startContainer: async (id: string) => {
      events.startCalls.push(id);
    },
  };
  return { client, scopeRegistry, events };
}

describe("createDockerAdapter", () => {
  test("returns a SandboxAdapter named 'docker' when client provided", async () => {
    const r = await createDockerAdapter({
      client: stubClient,
      scopeRegistry: createInMemoryScopeRegistry(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("docker");
  });

  test("create(profile) yields a SandboxInstance with working exec", async () => {
    const r = await createDockerAdapter({
      client: stubClient,
      scopeRegistry: createInMemoryScopeRegistry(),
    });
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

  test("rejects flag-shaped images before probing Docker availability", async () => {
    const probe = mock(async (): Promise<number> => 0);
    const r = await createDockerAdapter({ image: "--privileged", probe });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("VALIDATION");
      expect(r.error.message).toContain("must not start with '-'");
    }
    expect(probe).not.toHaveBeenCalled();
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
    const r = await createDockerAdapter({
      client: stubClient,
      scopeRegistry: createInMemoryScopeRegistry(),
    });
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
    const r = await createDockerAdapter({
      client: stubClient,
      scopeRegistry: createInMemoryScopeRegistry(),
    });
    if (!r.ok) throw new Error("setup failed");
    expect(r.value.findOrCreate).toBeUndefined();
    expect(r.value.capabilities?.supports.has("persistence")).toBe(false);
  });

  // Persistence: capable client → findOrCreate exposed, persistence cap declared.
  test("persistence-capable DockerClient declares persistence and exposes findOrCreate", async () => {
    const { client, scopeRegistry: reg } = persistentClient({});
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
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
    const {
      client,
      scopeRegistry: reg,
      events,
    } = persistentClient({
      preexisting: {
        container: existing,
        state: "running",
        labels: matchingLabels,
        scope: "scope-A",
      },
    });
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
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
    const {
      client,
      scopeRegistry: reg,
      events,
    } = persistentClient({
      preexisting: {
        container: existing,
        state: "stopped",
        labels: matchingLabels,
        scope: "scope-B",
      },
    });
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await r.value.findOrCreate("scope-B", PROFILE);
    expect(events.startCalls).toEqual(["existing-stopped"]);
    expect(events.createCalls.length).toBe(0);
  });

  // Persistence: exited containers are restarted.
  test("findOrCreate restarts an exited container", async () => {
    const existing = fakeContainer("existing-exited");
    const {
      client,
      scopeRegistry: reg,
      events,
    } = persistentClient({
      preexisting: {
        container: existing,
        state: "exited",
        labels: matchingLabels,
        scope: "scope-C",
      },
    });
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await r.value.findOrCreate("scope-C", PROFILE);
    expect(events.startCalls).toEqual(["existing-exited"]);
    expect(events.createCalls.length).toBe(0);
  });

  // Persistence: dead containers are abandoned and a fresh one is created with the scope label.
  test("findOrCreate creates a fresh labeled container when existing one is dead", async () => {
    const dead = fakeContainer("zombie");
    const {
      client,
      scopeRegistry: reg,
      events,
    } = persistentClient({
      preexisting: { container: dead, state: "dead", scope: "scope-D" },
    });
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await r.value.findOrCreate("scope-D", PROFILE);
    expect(events.startCalls.length).toBe(0);
    expect(events.createCalls.length).toBe(1);
    expect(events.createCalls[0]?.labels?.["koi.sandbox.scope"]).toBe("scope-D");
  });

  // Persistence: no container matches → fresh container with scope label is created.
  test("findOrCreate creates a fresh labeled container when none exists", async () => {
    const { client, scopeRegistry: reg, events } = persistentClient({});
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await r.value.findOrCreate("scope-E", PROFILE);
    expect(events.findCalls).toBe(1);
    expect(events.createCalls.length).toBe(1);
    expect(events.createCalls[0]?.labels?.["koi.sandbox.scope"]).toBe("scope-E");
  });

  // Persistence: profile with denyRead is still rejected on the findOrCreate path.
  test("findOrCreate throws on invalid profile (denyRead is unsupported)", async () => {
    const { client, scopeRegistry: reg } = persistentClient({});
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
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
    const {
      client,
      scopeRegistry: reg,
      events,
    } = persistentClient({
      preexisting: {
        container: existing,
        state: "running",
        labels: { "koi.sandbox.profile-hash": "deadbeefdeadbeef" },
        scope: "scope-G",
      },
    });
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
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
    const { client, scopeRegistry: reg } = persistentClient({
      preexisting: {
        container: existing,
        state: "running",
        labels: {},
        scope: "scope-H",
      },
    });
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await expect(r.value.findOrCreate("scope-H", PROFILE)).rejects.toThrow(/different profile/i);
  });

  // Persistence (fingerprint): fresh container is created with the profile-hash label set.
  test("findOrCreate stores profile-hash label on freshly created container", async () => {
    const { client, scopeRegistry: reg, events } = persistentClient({});
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
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
    const reg = createInMemoryScopeRegistry();
    const client: DockerClient = {
      createContainer: async (createOpts: DockerCreateOpts): Promise<DockerContainer> => {
        order.push(`create-start-${createCalls.length}`);
        createCalls.push(createOpts);
        await new Promise((res) => setTimeout(res, 20));
        order.push(`create-end-${createCalls.length - 1}`);
        return fakeContainer(`new-${createCalls.length}`);
      },
      findContainers: async () => {
        order.push(`find-${findCount}`);
        findCount += 1;
        return [];
      },
      inspectContainer: async () => undefined,
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
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
    const reg = createInMemoryScopeRegistry();
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => {
        order.push("create-start");
        await new Promise((res) => setTimeout(res, 20));
        order.push("create-end");
        return fakeContainer(`new-${order.length}`);
      },
      findContainers: async () => {
        const tag = `find-${findCount}`;
        findCount += 1;
        order.push(tag);
        return [];
      },
      inspectContainer: async () => undefined,
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
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

  // Cross-process race: name conflict + winner already recorded in our registry
  // → safely reattach. (Models a within-process race that beat the per-scope
  // serializer; in real cross-process scenarios the registry would have been
  // populated by a prior successful create in this process.)
  test("findOrCreate reattaches via name-conflict retry when registry already records the winner", async () => {
    const winner = fakeContainer("winner");
    let findCount = 0;
    const reg = createInMemoryScopeRegistry();
    // Pre-populate: this process previously recorded the winner's ID.
    void reg.record("scope-RACE-X", winner.id);
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => {
        // Daemon rejects our --name; rival already claims it.
        const e = Object.assign(new Error("name in use"), {
          code: DOCKER_NAME_CONFLICT_CODE,
        } as const);
        throw e;
      },
      findContainers: async () => {
        findCount += 1;
        return [winner];
      },
      inspectContainer: async () => ({
        state: "running",
        labels: { "koi.sandbox.profile-hash": PROFILE_HASH },
      }),
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    const inst = await r.value.findOrCreate("scope-RACE-X", PROFILE);
    expect(inst).toBeDefined();
    expect(findCount).toBeGreaterThanOrEqual(1);
  });

  // Security: name conflict + NO registry entry means the surviving container
  // is unverified (could be a peer process or attacker). Refuse to attach,
  // surface a VALIDATION error pointing at the container name so operators
  // can investigate.
  test("findOrCreate refuses to attach to an unverified container after name conflict", async () => {
    const stranger = fakeContainer("stranger");
    const reg = createInMemoryScopeRegistry();
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => {
        const e = Object.assign(new Error("name in use"), {
          code: DOCKER_NAME_CONFLICT_CODE,
        } as const);
        throw e;
      },
      // Daemon-side container exists with our scope label, but it's not in
      // OUR registry — could be a peer process or an attacker.
      findContainers: async () => [stranger],
      inspectContainer: async () => ({
        state: "running",
        labels: { "koi.sandbox.profile-hash": PROFILE_HASH },
      }),
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await expect(r.value.findOrCreate("scope-SQUAT", PROFILE)).rejects.toThrow(
      /do not own|already in use/i,
    );
  });

  // Persistence (cross-process race): the create call must include the
  // deterministic scope-derived container name so Docker enforces uniqueness.
  test("findOrCreate sends a deterministic --name (derived from scope) on create", async () => {
    const { client, scopeRegistry: reg, events } = persistentClient({});
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await r.value.findOrCreate("scope-NAME", PROFILE);
    expect(events.createCalls.length).toBe(1);
    expect(events.createCalls[0]?.name).toBe(deriveScopeContainerName("scope-NAME"));
  });

  // Drift recovery: destroyScope removes a scoped container (force-rm) and
  // frees the scope. Stop is intentionally NOT called — `docker rm -f`
  // handles running containers and a separate stop step previously caused
  // false-positive failures on already-stopped containers.
  test("destroyScope removes the scoped container without calling stop", async () => {
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
    const { client, scopeRegistry: reg } = persistentClient({
      preexisting: { container: existing, state: "running", labels: {}, scope: "scope-DROP" },
    });
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.destroyScope === undefined) throw new Error("destroyScope must exist");
    const wasDestroyed = await r.value.destroyScope("scope-DROP");
    expect(wasDestroyed).toBe(true);
    expect(removed).toBe(1);
    // Stop is NOT called — destroyScope relies on `docker rm -f` for force removal.
    expect(stopped).toBe(0);
  });

  // destroyScope returns false (idempotent) when nothing matches.
  test("destroyScope returns false when no scoped container exists", async () => {
    const { client, scopeRegistry: reg } = persistentClient({});
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.destroyScope === undefined) throw new Error("destroyScope must exist");
    const wasDestroyed = await r.value.destroyScope("scope-NONE");
    expect(wasDestroyed).toBe(false);
  });

  // destroyScope is omitted on minimal clients (no persistence triple).
  test("destroyScope is undefined when persistence is unavailable", async () => {
    const r = await createDockerAdapter({
      client: stubClient,
      scopeRegistry: createInMemoryScopeRegistry(),
    });
    if (!r.ok) throw new Error("setup failed");
    expect(r.value.destroyScope).toBeUndefined();
  });

  // Drift error message points at the supported recovery method (destroyScope).
  test("findOrCreate drift error references destroyScope as the recovery path", async () => {
    const existing = fakeContainer("drifted");
    const { client, scopeRegistry: reg } = persistentClient({
      preexisting: {
        scope: "scope-RECOVER",
        container: existing,
        state: "running",
        labels: { "koi.sandbox.profile-hash": "deadbeefdeadbeef" },
      },
    });
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await expect(r.value.findOrCreate("scope-RECOVER", PROFILE)).rejects.toThrow(/destroyScope/);
  });

  // Persistence (ambiguity): more than one container carrying the scope label
  // must fail closed and direct the operator at destroyScope.
  test("findOrCreate fails closed when multiple containers carry the same scope label", async () => {
    const a = fakeContainer("dup-a");
    const b = fakeContainer("dup-b");
    const reg = createInMemoryScopeRegistry();
    // Pre-record `a` so the trust check is satisfied — the failure mode under
    // test is the *count*, not the trust check.
    void reg.record("scope-DUP", a.id);
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => fakeContainer("never"),
      findContainers: async () => [a, b],
      inspectContainer: async () => ({
        state: "running",
        labels: { "koi.sandbox.profile-hash": PROFILE_HASH },
      }),
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await expect(r.value.findOrCreate("scope-DUP", PROFILE)).rejects.toThrow(
      /matches 2 containers/,
    );
  });

  // Persistence (ownership): destroyScope preflight-checks for foreign
  // siblings BEFORE removing the owned container — removing it first would
  // delete good state while leaving the scope wedged on the strangers (the
  // owner has lost their sandbox to no benefit). Fail closed with NO
  // mutations so the operator can clean up manually before retrying.
  test("destroyScope preflight refuses to remove owned container when foreign siblings exist", async () => {
    const stops: string[] = [];
    const removes: string[] = [];
    function tagged(id: string): DockerContainer {
      return {
        id,
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        readFile: async () => new Uint8Array(),
        writeFile: async () => {},
        stop: async () => {
          stops.push(id);
        },
        remove: async () => {
          removes.push(id);
        },
      };
    }
    const reg = createInMemoryScopeRegistry();
    void reg.record("scope-MULTI", "a");
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => tagged("never"),
      findContainers: async () => [tagged("a"), tagged("b"), tagged("c")],
      inspectContainer: async () => undefined,
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.destroyScope === undefined) throw new Error("destroyScope must exist");
    await expect(r.value.destroyScope("scope-MULTI")).rejects.toThrow(
      /refusing to remove the owned container while strangers remain/,
    );
    expect(stops).toEqual([]);
    // Critical: NOTHING is removed when foreign siblings are present —
    // partial demolition would erase the operator's good sandbox while
    // still leaving the scope wedged on the strangers.
    expect(removes).toEqual([]);
    // Ownership is preserved so the operator's sandbox can be re-attached
    // (or the scope can be retried) once the strangers are cleaned up.
    expect(await reg.lookup("scope-MULTI")).toBe("a");
  });

  // Persistence (no ownership): destroyScope refuses to delete label-matching
  // strangers when there is no registry entry — destroyScope is a recovery
  // primitive for OUR sandboxes, not a label-driven cluster `rm`.
  test("destroyScope refuses to delete unowned containers when registry has no entry", async () => {
    const removes: string[] = [];
    const stranger: DockerContainer = {
      ...fakeContainer("foreign"),
      remove: async () => {
        removes.push("foreign");
      },
    };
    const reg = createInMemoryScopeRegistry();
    const client: DockerClient = {
      createContainer: async () => fakeContainer("never"),
      findContainers: async () => [stranger],
      inspectContainer: async () => undefined,
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.destroyScope === undefined) throw new Error("destroyScope must exist");
    await expect(r.value.destroyScope("scope-FOREIGN")).rejects.toThrow(/containers we do not own/);
    // Critical: stranger is NOT removed.
    expect(removes).toEqual([]);
  });

  // Persistence (image drift): when resolveImageId returns a different ID for
  // the same tag (e.g. `:latest` repointed at new content), the recomputed
  // fingerprint must differ from the recorded one and reuse must fail closed.
  test("findOrCreate fails closed when image-id changes behind a stable tag", async () => {
    // Recorded fingerprint = (PROFILE, "ubuntu:22.04", "sha256:OLD").
    const recordedFingerprint = computeProfileFingerprint(PROFILE, "ubuntu:22.04", "sha256:OLD");
    const existing = fakeContainer("rebuilt");
    const reg = createInMemoryScopeRegistry();
    void reg.record("scope-IMG", existing.id);
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => fakeContainer("never"),
      findContainers: async () => [existing],
      inspectContainer: async () => ({
        state: "running",
        labels: { "koi.sandbox.profile-hash": recordedFingerprint },
      }),
      startContainer: async () => {},
      // Daemon now resolves the same tag to a different content-addressed ID.
      resolveImageId: async () => "sha256:NEW",
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await expect(r.value.findOrCreate("scope-IMG", PROFILE)).rejects.toThrow(/different profile/i);
  });

  // Persistence (image drift): same image-id ⇒ reuse succeeds (no spurious drift).
  test("findOrCreate reuses container when image-id matches the recorded fingerprint", async () => {
    const recordedFingerprint = computeProfileFingerprint(PROFILE, "ubuntu:22.04", "sha256:STABLE");
    const existing = fakeContainer("stable");
    const reg = createInMemoryScopeRegistry();
    void reg.record("scope-IMG-OK", existing.id);
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => fakeContainer("never"),
      findContainers: async () => [existing],
      inspectContainer: async () => ({
        state: "running",
        labels: { "koi.sandbox.profile-hash": recordedFingerprint },
      }),
      startContainer: async () => {},
      resolveImageId: async () => "sha256:STABLE",
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    const inst = await r.value.findOrCreate("scope-IMG-OK", PROFILE);
    expect(inst).toBeDefined();
  });

  // Security: a peer-process container with the right scope/hash labels but
  // an ID NOT in our registry must NOT be reattached to AND we must NOT
  // create a second labeled container alongside it (which would later trip
  // the multi-match ambiguity path and wedge the scope behind manual
  // cleanup). Fail closed immediately so the operator gets one actionable
  // error rather than a delayed DoS.
  test("findOrCreate fails closed when a label-matching container is not in our registry", async () => {
    const stranger = fakeContainer("stranger");
    const reg = createInMemoryScopeRegistry();
    // Registry intentionally empty — simulates a peer with daemon access who
    // fabricated the labels.
    let createCalls = 0;
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => {
        createCalls += 1;
        return fakeContainer("ours");
      },
      findContainers: async () => [stranger],
      inspectContainer: async () => ({
        state: "running",
        labels: { "koi.sandbox.profile-hash": PROFILE_HASH },
      }),
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await expect(r.value.findOrCreate("scope-SPOOF", PROFILE)).rejects.toThrow(/we do not own/);
    // Critical: we did NOT create a second labeled container.
    expect(createCalls).toBe(0);
  });

  // Security: dead container in the way must be auto-removed before retry, so
  // the deterministic --name doesn't permanently wedge the scope.
  test("findOrCreate auto-removes a dead container so the deterministic --name frees up", async () => {
    let removed = 0;
    const dead: DockerContainer = {
      id: "dead-one",
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      stop: async () => {},
      remove: async () => {
        removed += 1;
      },
    };
    const reg = createInMemoryScopeRegistry();
    void reg.record("scope-DEAD", dead.id);
    let findCalls = 0;
    let createCalls = 0;
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => {
        createCalls += 1;
        return fakeContainer(`new-${createCalls}`);
      },
      findContainers: async () => {
        findCalls += 1;
        // After remove(), the dead container is no longer in the list.
        return removed === 0 ? [dead] : [];
      },
      inspectContainer: async () => ({ state: "dead", labels: {} }),
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await r.value.findOrCreate("scope-DEAD", PROFILE);
    // Dead container removed; fresh container created.
    expect(removed).toBe(1);
    expect(createCalls).toBe(1);
    expect(findCalls).toBeGreaterThanOrEqual(1);
  });

  // Persistence (race): if the first call rejects, the chain must not deadlock the second.
  test("findOrCreate keeps the per-scope chain alive after a rejection", async () => {
    let attempts = 0;
    const reg = createInMemoryScopeRegistry();
    const client: DockerClient = {
      createContainer: async (): Promise<DockerContainer> => {
        attempts += 1;
        if (attempts === 1) throw new Error("synthetic create failure");
        return fakeContainer("recovered");
      },
      findContainers: async () => [],
      inspectContainer: async () => undefined,
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");

    const p1 = r.value.findOrCreate("scope-CHAIN", PROFILE);
    const p2 = r.value.findOrCreate("scope-CHAIN", PROFILE);
    await expect(p1).rejects.toThrow("synthetic create failure");
    const inst = await p2;
    expect(inst).toBeDefined();
    expect(attempts).toBe(2);
  });

  // Persistence (record failure): if scopeRegistry.record throws after a
  // successful create, the just-created container must be removed so the
  // deterministic --name is freed and the scope does not wedge permanently.
  test("findOrCreate removes the container if scopeRegistry.record fails", async () => {
    const created = fakeContainer("about-to-be-rolled-back");
    let removed = false;
    const trackedContainer: DockerContainer = {
      ...created,
      remove: async () => {
        removed = true;
      },
    };
    const failingRegistry: ScopeRegistry = {
      record: async () => {
        throw new Error("disk full");
      },
      lookup: async () => undefined,
      forget: async () => {},
      forgetIfMatches: async () => false,
    };
    const client: DockerClient = {
      createContainer: async () => trackedContainer,
      findContainers: async () => [],
      inspectContainer: async () => undefined,
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: failingRegistry });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await expect(r.value.findOrCreate("scope-RECFAIL", PROFILE)).rejects.toThrow("disk full");
    // Critical: the deterministic --name must be released for the next caller.
    expect(removed).toBe(true);
  });

  // Persistence (loser-race retry): a peer process won the deterministic-name
  // race and will record the winner ID shortly. The loser must retry the
  // registry-trust check long enough for the winner's record to land instead
  // of immediately false-positive failing as "stranger container".
  test("findOrCreate retries the trust check so the winner's record can land", async () => {
    const winner = fakeContainer("winner-c1");
    const reg = createInMemoryScopeRegistry();
    let lookups = 0;
    const trackingReg: ScopeRegistry = {
      record: reg.record,
      lookup: async (scope) => {
        lookups += 1;
        // Simulate the winner's record landing on the 3rd lookup attempt.
        if (lookups === 3) await reg.record("scope-LOSER", winner.id);
        return reg.lookup(scope);
      },
      forget: reg.forget,
      forgetIfMatches: reg.forgetIfMatches,
    };
    // Realistic loser race: pre-create sees no matches (winner hasn't
    // created yet), createContainer throws name-conflict (winner won the
    // race), post-conflict findContainers now sees the winner. The
    // post-conflict retry must wait for the winner's record() to land
    // rather than treating "no entry yet" as a hard stranger failure.
    let createAttempted = false;
    const client: DockerClient = {
      createContainer: async () => {
        createAttempted = true;
        const err = Object.assign(new Error("name taken"), {
          code: DOCKER_NAME_CONFLICT_CODE,
        });
        throw err;
      },
      findContainers: async () => (createAttempted ? [winner] : []),
      inspectContainer: async () => ({
        state: "running",
        labels: { "koi.sandbox.profile-hash": PROFILE_HASH },
      }),
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: trackingReg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    const inst = await r.value.findOrCreate("scope-LOSER", PROFILE);
    expect(inst).toBeDefined();
    // First call (pre-create) + retries until winner's record landed.
    expect(lookups).toBeGreaterThanOrEqual(3);
  });

  // Persistence (destroyScope partial failure): if any container.remove()
  // throws, the registry entry MUST be preserved so a later destroyScope
  // (or `findOrCreate` after operator cleanup) can still trust the survivor.
  // Forgetting before remove succeeded would classify the survivor as a
  // stranger and permanently wedge the scope.
  test("destroyScope preserves registry entry when the owned container.remove fails", async () => {
    const owned: DockerContainer = {
      ...fakeContainer("owned-fail"),
      remove: async () => {
        throw new Error("docker rm failed");
      },
    };
    const reg = createInMemoryScopeRegistry();
    void reg.record("scope-PARTIAL", owned.id);
    const client: DockerClient = {
      createContainer: async () => fakeContainer("never"),
      findContainers: async () => [owned],
      inspectContainer: async () => ({ state: "running", labels: {} }),
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.destroyScope === undefined) throw new Error("destroyScope must exist");
    await expect(r.value.destroyScope("scope-PARTIAL")).rejects.toThrow("docker rm failed");
    // Critical: registry still holds the recorded ID so the next destroyScope
    // (or operator-driven cleanup) can still trust the surviving container.
    expect(await reg.lookup("scope-PARTIAL")).toBe(owned.id);
  });

  // Persistence (transient inspect failure): a thrown inspectContainer must
  // propagate, NOT be silently treated as "container vanished". Otherwise a
  // momentary daemon hiccup would erase ownership for a still-existing
  // container and wedge the scope on the deterministic --name.
  test("findOrCreate propagates a transient inspectContainer error and keeps the registry", async () => {
    const existing = fakeContainer("transient-c1");
    const reg = createInMemoryScopeRegistry();
    void reg.record("scope-TRANSIENT", existing.id);
    const client: DockerClient = {
      createContainer: async () => fakeContainer("never"),
      findContainers: async () => [existing],
      inspectContainer: async () => {
        throw new Error("Cannot connect to the Docker daemon");
      },
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    await expect(r.value.findOrCreate("scope-TRANSIENT", PROFILE)).rejects.toThrow(
      "Cannot connect to the Docker daemon",
    );
    // Registry MUST still hold the recorded ID — the next attempt should
    // be able to reattach once the daemon is healthy.
    expect(await reg.lookup("scope-TRANSIENT")).toBe(existing.id);
  });

  // Persistence (cross-process race): destroyScope must use CAS-by-id when
  // forgetting so a peer process that recorded a brand-new replacement
  // between our lookup and our cleanup is not silently de-trusted.
  test("destroyScope CAS-forget preserves a peer's freshly recorded replacement", async () => {
    const oldOwned = fakeContainer("old-owned");
    const peerReplacement = "peer-new-id";
    const reg = createInMemoryScopeRegistry();
    void reg.record("scope-RACE", oldOwned.id);
    const client: DockerClient = {
      createContainer: async () => fakeContainer("never"),
      // After our remove(), simulate the peer having already replaced us:
      // findContainers no longer sees the old container.
      findContainers: async () => [oldOwned],
      inspectContainer: async () => ({ state: "running", labels: {} }),
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.destroyScope === undefined) throw new Error("destroyScope must exist");
    // Inject a peer record() between our remove and forget by wrapping
    // oldOwned.remove to land the peer's record before we call forget.
    const tracked: DockerContainer = {
      ...oldOwned,
      remove: async () => {
        // Peer process succeeded in recreating the scope while we were
        // mid-destroy.
        await reg.record("scope-RACE", peerReplacement);
      },
    };
    const racingClient: DockerClient = {
      ...client,
      findContainers: async () => [tracked],
    };
    const r2 = await createDockerAdapter({ client: racingClient, scopeRegistry: reg });
    if (!r2.ok) throw new Error("setup failed");
    if (r2.value.destroyScope === undefined) throw new Error("destroyScope must exist");
    await r2.value.destroyScope("scope-RACE");
    // Critical: peer's brand-new ownership record MUST survive.
    expect(await reg.lookup("scope-RACE")).toBe(peerReplacement);
  });

  // Persistence (cross-process race): tryReuse cleanup of a vanished/dead
  // container must use CAS-by-id so a peer's freshly-recorded replacement
  // ID is preserved.
  test("tryReuse CAS-forget on vanished container preserves a peer's replacement record", async () => {
    const stale = fakeContainer("stale-id");
    const reg = createInMemoryScopeRegistry();
    void reg.record("scope-VANISH", stale.id);
    const client: DockerClient = {
      // After tryReuse cleanup, adapter would proceed to create — make that
      // throw so we can assert the registry state immediately after the
      // vanish-cleanup step.
      createContainer: async () => {
        throw new Error("blocked-for-test");
      },
      findContainers: async () => [stale],
      // Simulate peer recording the replacement during our inspect call:
      // inspectContainer races with the registry mutation.
      inspectContainer: async () => {
        await reg.record("scope-VANISH", "peer-replaces");
        // Container vanished from the daemon's perspective.
        return undefined;
      },
      startContainer: async () => {},
    };
    const r = await createDockerAdapter({ client, scopeRegistry: reg });
    if (!r.ok) throw new Error("setup failed");
    if (r.value.findOrCreate === undefined) throw new Error("findOrCreate must exist");
    // findOrCreate sees stale entry, peer's record lands during inspect,
    // forgetIfMatches(stale.id) MUST NOT delete the peer's "peer-replaces"
    // entry. Then create throws (synthetic), letting us inspect the state.
    await expect(r.value.findOrCreate("scope-VANISH", PROFILE)).rejects.toThrow("blocked-for-test");
    expect(await reg.lookup("scope-VANISH")).toBe("peer-replaces");
  });
});
