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

    // Simulate CLI bg kill claim: write "terminating" + fresh signaledAt
    // before the crash. The bridge only honors the downgrade when the
    // signaledAt timestamp is within its freshness window.
    const claim = await registry.update(id, {
      status: "terminating",
      signaledAt: Date.now(),
    });
    expect(claim.ok).toBe(true);

    crash(id);
    await waitForStatus(registry, id, "exited");

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("keeps crashed when terminating claim is stale (signaledAt expired)", async () => {
    // A stranded `terminating` record from a killer that aborted partway
    // must NOT convert a later genuine crash into `exited`. The bridge
    // honors the downgrade only when `signaledAt` is within the freshness
    // window — we simulate a stale claim by writing a very old timestamp.
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

    const id = workerId("w-stale-term");
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

    // Stranded claim: status=terminating but signaledAt is ancient.
    // The bridge must NOT trust this as an operator-initiated kill.
    const claim = await registry.update(id, {
      status: "terminating",
      signaledAt: Date.now() - 60 * 60 * 1000, // 1h ago
    });
    expect(claim.ok).toBe(true);

    crash(id);
    await waitForStatus(registry, id, "crashed");

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("keeps crashed when signaledAt is a future timestamp (clock skew / corruption)", async () => {
    // A `signaledAt` in the future produces a negative `Date.now() -
    // signaledAt`. Without a lower-bound check, that trivially satisfies
    // `age <= TERMINATING_FRESHNESS_MS` and the bridge would downgrade a
    // genuine crash forever. Defense against NTP step, DST shifts,
    // manual edits, or attacker-planted records.
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

    const id = workerId("w-future-sig");
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

    // Future timestamp — age would be negative.
    const claim = await registry.update(id, {
      status: "terminating",
      signaledAt: Date.now() + 24 * 60 * 60 * 1000, // 1d in the future
    });
    expect(claim.ok).toBe(true);

    crash(id);
    await waitForStatus(registry, id, "crashed");

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("keeps crashed when terminating claim has no signaledAt", async () => {
    // Legacy / hand-edited records may carry status=terminating without a
    // signaledAt timestamp. Without proof of recency the bridge must treat
    // the subsequent crash as a genuine fault, not an operator kill.
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

    const id = workerId("w-no-signaled-at");
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

    // status=terminating with NO signaledAt (operator edit, legacy record).
    const claim = await registry.update(id, { status: "terminating" });
    expect(claim.ok).toBe(true);

    crash(id);
    await waitForStatus(registry, id, "crashed");

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("clears stale signaledAt on started event so restarts don't inherit kill intent", async () => {
    // A restarted worker under the same workerId must not inherit a
    // prior kill's `signaledAt`: otherwise a genuine crash of the
    // fresh process within the freshness window would be misclassified
    // as operator-initiated `exited`. The bridge writes
    // `clearSignaledAt: true` on every `started` event to enforce this.
    const { backend, crash } = createFakeBackend();
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
      restart: {
        restart: "transient",
        maxRestarts: 5,
        maxRestartWindowMs: 10_000,
        backoffBaseMs: 10,
        backoffCeilingMs: 100,
      },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;

    const registry = createFileSessionRegistry({ dir });
    const bridge = attachRegistry({ supervisor, registry });

    const id = workerId("w-stale-clear");
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

    // Plant a fresh signaledAt + terminating claim, as if from a prior
    // kill attempt that finalized but the bridge hasn't yet seen a
    // started event since.
    await registry.update(id, {
      status: "terminating",
      signaledAt: Date.now(),
    });

    // Now crash it; bridge sees crashed → transient restart fires →
    // started event clears signaledAt on the registry record.
    crash(id);
    await waitForStatus(registry, id, "running"); // Wait for restart.

    const afterRestart = await registry.get(id);
    expect(afterRestart?.signaledAt).toBeUndefined();

    // Second crash (fresh process, no operator intent) must stay crashed.
    crash(id);
    await waitForStatus(registry, id, "crashed");

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

  it("sweeps terminal records older than the 24h retention window on terminal events", async () => {
    const { backend, exit } = createFakeBackend();
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;

    const registry = createFileSessionRegistry({ dir });
    const bridge = attachRegistry({ supervisor, registry });

    // Pre-seed an "old" terminal record: endedAt is 25h in the past. The
    // bridge's opportunistic sweep (D7) should evict it the next time it
    // writes a terminal status for any worker.
    const stale = workerId("w-stale");
    const dayMs = 24 * 60 * 60 * 1000;
    await registry.register({
      workerId: stale,
      agentId: agentId("a"),
      pid: 99,
      status: "exited",
      startedAt: Date.now() - 26 * 60 * 60 * 1000,
      endedAt: Date.now() - 25 * 60 * 60 * 1000,
      exitCode: 0,
      logPath: "",
      command: ["noop"],
      backendKind: "in-process",
    });
    expect(await registry.get(stale)).toBeDefined();

    // A fresh terminal record (endedAt inside the window) must survive.
    const recent = workerId("w-recent");
    await registry.register({
      workerId: recent,
      agentId: agentId("a"),
      pid: 100,
      status: "exited",
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 60_000,
      exitCode: 0,
      logPath: "",
      command: ["noop"],
      backendKind: "in-process",
    });

    // Live worker to trigger a real exited event, which invokes the sweep.
    const live = workerId("w-live");
    await registry.register({
      workerId: live,
      agentId: agentId("a"),
      pid: 1,
      status: "starting",
      startedAt: Date.now(),
      logPath: "",
      command: ["noop"],
      backendKind: "in-process",
    });
    await supervisor.start({
      workerId: live,
      agentId: agentId("a"),
      command: ["noop"],
    });
    await waitForStatus(registry, live, "running");
    exit(live, 0);
    await waitForStatus(registry, live, "exited");

    // Sweep is fire-and-forget (`void registry.unregister(...).catch(...)`);
    // poll until the stale record is gone rather than asserting synchronously.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if ((await registry.get(stale)) === undefined) break;
      await Bun.sleep(10);
    }
    expect(await registry.get(stale)).toBeUndefined();
    expect(await registry.get(recent)).toBeDefined();
    // Hint to the linter that `dayMs` is load-bearing: the retention window
    // length is the contract this test encodes.
    expect(dayMs).toBe(24 * 60 * 60 * 1000);

    await supervisor.shutdown("test-done");
    await bridge.close();
  });
});
