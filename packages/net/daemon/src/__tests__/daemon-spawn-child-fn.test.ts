import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentId,
  AgentManifest,
  AgentRegistry,
  ChildSpec,
  PatchableRegistryFields,
  ProcessState,
  RegistryEntry,
  TransitionReason,
} from "@koi/core";
import { agentId } from "@koi/core";
import { attachAgentRegistry } from "../agent-registry-bridge.js";
import { createSupervisor } from "../create-supervisor.js";
import { createDaemonSpawnChildFn } from "../daemon-spawn-child-fn.js";
import { createFileSessionRegistry } from "../file-session-registry.js";
import { createFakeBackend } from "./fake-backend.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "koi-daemon-spawn-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function createStubAgentRegistry(): AgentRegistry {
  const entries = new Map<string, RegistryEntry>();
  return {
    register: (entry: RegistryEntry) => {
      entries.set(entry.agentId, entry);
      return entry;
    },
    deregister: (id: AgentId) => entries.delete(id),
    lookup: (id: AgentId) => entries.get(id),
    list: () => Array.from(entries.values()),
    transition: (id: AgentId, phase: ProcessState, gen: number, _reason: TransitionReason) => {
      const e = entries.get(id);
      if (e === undefined) {
        return {
          ok: false as const,
          error: { code: "NOT_FOUND", message: "not found", retryable: false },
        };
      }
      const next: RegistryEntry = {
        ...e,
        status: {
          phase,
          generation: gen + 1,
          conditions: [],
          lastTransitionAt: Date.now(),
        },
      };
      entries.set(id, next);
      return { ok: true as const, value: next };
    },
    patch: (id: AgentId, _fields: PatchableRegistryFields) => {
      const e = entries.get(id);
      if (e === undefined) {
        return {
          ok: false as const,
          error: { code: "NOT_FOUND", message: "not found", retryable: false },
        };
      }
      return { ok: true as const, value: e };
    },
    watch: () => () => undefined,
    [Symbol.asyncDispose]: async () => {
      entries.clear();
    },
  };
}

const CHILD_SPEC: ChildSpec = {
  name: "worker",
  restart: "permanent",
  isolation: "subprocess",
};

const MANIFEST: AgentManifest = {
  name: "supervised-worker",
  version: "1.0.0",
  model: { name: "test-model" },
};

describe("createDaemonSpawnChildFn", () => {
  it("rejects non-subprocess isolation", async () => {
    const { backend } = createFakeBackend("subprocess");
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { subprocess: backend },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;
    const sessionRegistry = createFileSessionRegistry({ dir });
    const agentRegistry = createStubAgentRegistry();
    const bridge = attachAgentRegistry({ supervisor, agentRegistry });
    const spawn = createDaemonSpawnChildFn({
      supervisor,
      sessionRegistry,
      agentRegistry,
      bridge,
      commandBuilder: () => ["noop"],
    });

    const parent = agentId("parent");
    await expect(
      spawn(parent, { name: "x", restart: "permanent", isolation: "in-process" }, MANIFEST),
    ).rejects.toThrow(/isolation="in-process"/);

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("registers in both registries and maps the worker before start", async () => {
    const { backend, exit } = createFakeBackend("subprocess");
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { subprocess: backend },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;
    const sessionRegistry = createFileSessionRegistry({ dir });
    const agentRegistry = createStubAgentRegistry();
    const bridge = attachAgentRegistry({ supervisor, agentRegistry });

    let counter = 0;
    const spawn = createDaemonSpawnChildFn({
      supervisor,
      sessionRegistry,
      agentRegistry,
      bridge,
      commandBuilder: () => ["noop"],
      idSuffix: () => {
        counter += 1;
        return `t${counter}`;
      },
    });

    const parent = agentId("parent-1");
    const child = await spawn(parent, CHILD_SPEC, MANIFEST);
    expect(String(child)).toBe("parent-1.worker-t1");

    // AgentRegistry entry has parentId + childSpecName metadata.
    const entry = agentRegistry.lookup(child);
    if (entry instanceof Promise) throw new Error("sync expected");
    expect(entry?.parentId).toBe(parent);
    expect(entry?.metadata.childSpecName).toBe("worker");

    // BackgroundSessionRegistry entry has backendKind=subprocess.
    const sessions = await sessionRegistry.list();
    const session = sessions.find((s) => s.agentId === child);
    expect(session).toBeDefined();
    expect(session?.backendKind).toBe("subprocess");
    expect(session?.command).toEqual(["noop"]);

    // The `started` event from the fake backend should have flowed through
    // the bridge and transitioned the agent to running.
    for (let i = 0; i < 50; i++) {
      const e = agentRegistry.lookup(child);
      if (e instanceof Promise) throw new Error("sync expected");
      if (e?.status.phase === "running") break;
      await Bun.sleep(5);
    }
    const running = agentRegistry.lookup(child);
    if (running instanceof Promise) throw new Error("sync expected");
    expect(running?.status.phase).toBe("running");

    // Cleanly tear down.
    if (session === undefined) throw new Error("session missing");
    exit(session.workerId, 0);
    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("mints a fresh agentId on each call (restart-safe)", async () => {
    const { backend } = createFakeBackend("subprocess");
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { subprocess: backend },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;
    const sessionRegistry = createFileSessionRegistry({ dir });
    const agentRegistry = createStubAgentRegistry();
    const bridge = attachAgentRegistry({ supervisor, agentRegistry });

    let n = 0;
    const spawn = createDaemonSpawnChildFn({
      supervisor,
      sessionRegistry,
      agentRegistry,
      bridge,
      commandBuilder: () => ["noop"],
      idSuffix: () => {
        n += 1;
        return `run${n}`;
      },
    });

    const parent = agentId("p");
    const first = await spawn(parent, CHILD_SPEC, MANIFEST);
    const second = await spawn(parent, CHILD_SPEC, MANIFEST);
    expect(first).not.toBe(second);
    expect(String(first)).toBe("p.worker-run1");
    expect(String(second)).toBe("p.worker-run2");

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("rejects an empty command from the builder", async () => {
    const { backend } = createFakeBackend("subprocess");
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { subprocess: backend },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;
    const sessionRegistry = createFileSessionRegistry({ dir });
    const agentRegistry = createStubAgentRegistry();
    const bridge = attachAgentRegistry({ supervisor, agentRegistry });

    const spawn = createDaemonSpawnChildFn({
      supervisor,
      sessionRegistry,
      agentRegistry,
      bridge,
      commandBuilder: () => [],
    });

    await expect(spawn(agentId("p"), CHILD_SPEC, MANIFEST)).rejects.toThrow(/empty command/);

    await supervisor.shutdown("test-done");
    await bridge.close();
  });

  it("composes logPath from logDir + workerId", async () => {
    const { backend, exit } = createFakeBackend("subprocess");
    const supResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { subprocess: backend },
    });
    if (!supResult.ok) return;
    const supervisor = supResult.value;
    const sessionRegistry = createFileSessionRegistry({ dir });
    const agentRegistry = createStubAgentRegistry();
    const bridge = attachAgentRegistry({ supervisor, agentRegistry });

    const logDir = "/tmp/koi-logs-test";
    const spawn = createDaemonSpawnChildFn({
      supervisor,
      sessionRegistry,
      agentRegistry,
      bridge,
      commandBuilder: () => ["noop"],
      logDir,
      idSuffix: () => "abc",
    });

    const child = await spawn(agentId("p"), CHILD_SPEC, MANIFEST);
    const sessions = await sessionRegistry.list();
    const session = sessions.find((s) => s.agentId === child);
    expect(session?.logPath).toBe(`${logDir}/${session?.workerId}.log`);

    if (session === undefined) throw new Error("session missing");
    exit(session.workerId, 0);
    await supervisor.shutdown("test-done");
    await bridge.close();
  });
});
