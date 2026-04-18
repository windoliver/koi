import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentId, workerId } from "@koi/core";
import { createSupervisor } from "../create-supervisor.js";
import { createFileSessionRegistry } from "../file-session-registry.js";
import { attachRegistry } from "../registry-supervisor-bridge.js";
import { createFakeBackend } from "./fake-backend.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "koi-bridge-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function waitForStatus(
  registry: ReturnType<typeof createFileSessionRegistry>,
  id: ReturnType<typeof workerId>,
  expected: string,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "(never)";
  while (Date.now() < deadline) {
    const r = await registry.get(id);
    last = r?.status ?? "(missing)";
    if (r?.status === expected) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for status=${expected}, last=${last}`);
}

describe("attachRegistry", () => {
  it("reflects started/exited lifecycle in registry", async () => {
    const { backend, exit } = createFakeBackend();
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
    });
    expect(supResult.ok).toBe(true);
    if (!supResult.ok) return;
    const supervisor = supResult.value;

    const registry = createFileSessionRegistry({ dir });
    const bridge = attachRegistry({ supervisor, registry });

    const id = workerId("w-1");
    await registry.register({
      workerId: id,
      agentId: agentId("a"),
      pid: 1,
      status: "starting",
      startedAt: Date.now(),
      logPath: "",
      command: ["noop"],
      backendKind: "in-process",
    });

    await supervisor.start({
      workerId: id,
      agentId: agentId("a"),
      command: ["noop"],
    });

    await waitForStatus(registry, id, "running");

    exit(id, 0);

    await waitForStatus(registry, id, "exited");
    const final = await registry.get(id);
    expect(final?.exitCode).toBe(0);
    expect(final?.endedAt).toBeGreaterThan(0);

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("marks crashed workers as crashed", async () => {
    const { backend, crash } = createFakeBackend();
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
      restart: {
        restart: "temporary",
        maxRestarts: 0,
        maxRestartWindowMs: 1000,
        backoffBaseMs: 10,
        backoffCeilingMs: 100,
      },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;

    const registry = createFileSessionRegistry({ dir });
    const bridge = attachRegistry({ supervisor, registry });

    const id = workerId("w-crash");
    await registry.register({
      workerId: id,
      agentId: agentId("a"),
      pid: 0,
      status: "starting",
      startedAt: Date.now(),
      logPath: "",
      command: ["noop"],
      backendKind: "in-process",
    });
    await supervisor.start({
      workerId: id,
      agentId: agentId("a"),
      command: ["noop"],
    });

    await waitForStatus(registry, id, "running");
    crash(id);
    await waitForStatus(registry, id, "crashed");

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("refreshes pid and startedAt on every started event", async () => {
    const controls = createFakeBackend({ kind: "in-process", pidSeed: 2000 });
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": controls.backend },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;

    const registry = createFileSessionRegistry({ dir });
    const bridge = attachRegistry({ supervisor, registry });

    const id = workerId("w-refresh");
    await registry.register({
      workerId: id,
      agentId: agentId("a"),
      pid: 1, // stale initial pid — bridge must overwrite with backend's real pid
      status: "starting",
      startedAt: 1,
      logPath: "",
      command: ["noop"],
      backendKind: "in-process",
    });

    const before = Date.now();
    await supervisor.start({
      workerId: id,
      agentId: agentId("a"),
      command: ["noop"],
    });

    await waitForStatus(registry, id, "running");
    const snap = await registry.get(id);
    expect(snap?.pid).toBe(2000);
    expect((snap?.startedAt ?? 0) >= before).toBe(true);

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("downgrades crashed→exited when CLI pre-claimed terminating", async () => {
    // Simulates `koi bg kill`: external process writes status=terminating
    // under CAS, worker then dies via SIGTERM, supervisor sees an
    // unsolicited non-zero exit and publishes `crashed`. The bridge must
    // recognize the pre-claimed intent and record the terminal state as
    // `exited` instead of a misleading `crashed`.
    const { backend, crash } = createFakeBackend();
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
      restart: {
        restart: "temporary",
        maxRestarts: 0,
        maxRestartWindowMs: 1000,
        backoffBaseMs: 10,
        backoffCeilingMs: 100,
      },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;

    const registry = createFileSessionRegistry({ dir });
    const bridge = attachRegistry({ supervisor, registry });

    const id = workerId("w-op-kill");
    await registry.register({
      workerId: id,
      agentId: agentId("a"),
      pid: 999,
      status: "starting",
      startedAt: Date.now(),
      logPath: "",
      command: ["noop"],
      backendKind: "in-process",
    });

    await supervisor.start({
      workerId: id,
      agentId: agentId("a"),
      command: ["noop"],
    });
    await waitForStatus(registry, id, "running");

    // Simulate CLI bg kill claim: write "terminating" before the crash.
    const claim = await registry.update(id, { status: "terminating" });
    expect(claim.ok).toBe(true);

    crash(id);
    await waitForStatus(registry, id, "exited");

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("surfaces errors for unregistered workers without throwing", async () => {
    const { backend, exit } = createFakeBackend();
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;

    const registry = createFileSessionRegistry({ dir });
    const errors: string[] = [];
    const bridge = attachRegistry({
      supervisor,
      registry,
      onError: (err) => {
        errors.push(err.code);
      },
    });

    const id = workerId("w-unregistered");
    // Intentionally skip registry.register → update must return NOT_FOUND.
    await supervisor.start({
      workerId: id,
      agentId: agentId("a"),
      command: ["noop"],
    });
    exit(id, 0);
    // Give the loop time to process events.
    await Bun.sleep(50);

    expect(errors).toContain("NOT_FOUND");
    expect(bridge.lastError()?.code).toBe("NOT_FOUND");

    await supervisor.shutdown("test-done");
    await bridge.close();
  });
});
