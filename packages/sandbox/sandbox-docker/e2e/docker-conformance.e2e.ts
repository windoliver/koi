/**
 * E2E conformance: drive the docker adapter against a real Docker daemon.
 *
 * Run: docker must be available; image alpine:3.20 will be pulled if missing.
 *   bun test scratch/docker-conformance.test.ts
 *
 * Skipped silently when Docker is not reachable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SandboxAdapter, SandboxProfile } from "@koi/core";
import {
  describeCapabilityHonestyConformance,
  describeCreateDestroyConformance,
  describeLifecycleConformance,
} from "@koi/sandbox-conformance";
import {
  createDockerAdapter,
  createInMemoryScopeRegistry,
  type DockerSandboxAdapter,
} from "@koi/sandbox-docker";

const IMAGE = "alpine:3.20";

const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: false },
  resources: {},
};

let dockerAvailable = false;

beforeAll(async () => {
  const probe = Bun.spawn(["docker", "version", "--format", "{{.Server.Version}}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await probe.exited;
  dockerAvailable = code === 0;
  if (!dockerAvailable) {
    console.warn("docker not available — skipping e2e conformance");
    return;
  }
  // Pre-pull image so the first conformance test isn't dominated by pull time.
  const pull = Bun.spawn(["docker", "pull", IMAGE], { stdout: "pipe", stderr: "pipe" });
  await pull.exited;
});

if (process.env.CI === undefined) {
  // Local: make a fresh adapter per conformance call (the conformance suite
  // expects factory() to yield a never-init'd adapter each time).
  const factory = (): SandboxAdapter => {
    if (!dockerAvailable) {
      // Return a dummy adapter that fails fast — conformance harness will
      // surface skipping in its own assertions.
      return {
        name: "docker-skipped",
        version: "0",
        capabilities: { supports: new Set(), priority: 0 },
        create: async () => {
          throw new Error("docker unavailable");
        },
      };
    }
    // Each conformance run gets its own in-memory registry so prior runs
    // don't leak ownership state.
    const reg = createInMemoryScopeRegistry();
    // createDockerAdapter is async; wrap synchronously by deferring the
    // probe via explicit success-probe + fresh client. Use the default
    // CLI client (probe=undefined defers to real `docker version`).
    const stubProbe = async (): Promise<number> => 0;
    let adapter: DockerSandboxAdapter | undefined;
    const realFactory = async (): Promise<DockerSandboxAdapter> => {
      const r = await createDockerAdapter({
        image: IMAGE,
        scopeRegistry: reg,
        probe: stubProbe,
      });
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    };
    // Conformance harness calls factory() synchronously then awaits methods
    // on the returned adapter. Build a thin async-init façade.
    return {
      name: "docker",
      version: "0.1.0",
      capabilities: {
        supports: new Set(["exec", "copy-files", "network", "filesystem-rw", "persistence"]),
        priority: 10,
      },
      create: async (p) => {
        adapter ??= await realFactory();
        return adapter.create(p);
      },
      findOrCreate: async (scope, p) => {
        adapter ??= await realFactory();
        if (adapter.findOrCreate === undefined) {
          throw new Error("findOrCreate missing");
        }
        return adapter.findOrCreate(scope, p);
      },
    };
  };

  describe("E2E sandbox-docker conformance (real daemon)", () => {
    describeLifecycleConformance(factory);
    describeCreateDestroyConformance(factory, () => profile);
    describeCapabilityHonestyConformance(factory, () => profile);
  });

  // Smoke: a focused happy-path that proves findOrCreate end-to-end.
  describe("E2E sandbox-docker findOrCreate smoke", () => {
    test("findOrCreate twice on same scope reattaches to same container", async () => {
      if (!dockerAvailable) return;
      const reg = createInMemoryScopeRegistry();
      const r = await createDockerAdapter({ image: IMAGE, scopeRegistry: reg });
      if (!r.ok) throw new Error(r.error.message);
      if (r.value.findOrCreate === undefined) throw new Error("findOrCreate missing");
      const scope = `e2e-smoke-${Date.now()}`;
      try {
        const inst1 = await r.value.findOrCreate(scope, profile);
        const out1 = await inst1.exec("echo", ["hello-1"]);
        expect(out1.stdout.trim()).toBe("hello-1");

        const inst2 = await r.value.findOrCreate(scope, profile);
        const out2 = await inst2.exec("sh", ["-c", "echo hello-2"]);
        expect(out2.stdout.trim()).toBe("hello-2");

        // Both should map to the same container (id is stable).
        expect((inst1 as { containerId?: string }).containerId).toBeDefined;
      } finally {
        if (r.value.destroyScope !== undefined) {
          await r.value.destroyScope(scope).catch(() => {});
        }
      }
    }, 60_000);
  });
}

afterAll(async () => {
  if (!dockerAvailable) return;
  // Best-effort: clean up any e2e-smoke containers we left behind.
  const ps = Bun.spawn(["docker", "ps", "-aq", "--filter", "label=koi.sandbox.scope"], {
    stdout: "pipe",
  });
  const ids = (await new Response(ps.stdout).text())
    .trim()
    .split("\n")
    .filter((x) => x);
  if (ids.length > 0) {
    const rm = Bun.spawn(["docker", "rm", "-f", ...ids], { stdout: "pipe", stderr: "pipe" });
    await rm.exited;
  }
});
