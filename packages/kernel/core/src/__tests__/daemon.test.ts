import { describe, expect, it } from "bun:test";
import type { BackgroundSessionRecord, SupervisorConfig, WorkerBackend } from "../daemon.js";
import { validateBackgroundSessionRecord, validateSupervisorConfig, workerId } from "../daemon.js";
import { agentId } from "../ecs.js";

const fakeBackend = {
  kind: "in-process",
  displayName: "fake",
  isAvailable: () => true,
  spawn: async () => ({
    ok: false,
    error: { code: "INTERNAL", message: "stub", retryable: false },
  }),
  terminate: async () => ({ ok: true, value: undefined }),
  kill: async () => ({ ok: true, value: undefined }),
  isAlive: async () => false,
  watch: async function* () {},
} satisfies WorkerBackend;

describe("validateSupervisorConfig", () => {
  it("rejects maxWorkers < 1", () => {
    const result = validateSupervisorConfig({
      maxWorkers: 0,
      shutdownDeadlineMs: 10_000,
      backends: { "in-process": fakeBackend } as SupervisorConfig["backends"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  it("rejects empty backend registry", () => {
    const result = validateSupervisorConfig({
      maxWorkers: 4,
      shutdownDeadlineMs: 10_000,
      backends: {} as SupervisorConfig["backends"],
    });
    expect(result.ok).toBe(false);
  });

  it("accepts valid config", () => {
    const result = validateSupervisorConfig({
      maxWorkers: 4,
      shutdownDeadlineMs: 10_000,
      backends: { "in-process": fakeBackend } as SupervisorConfig["backends"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects negative shutdownDeadlineMs", () => {
    const result = validateSupervisorConfig({
      maxWorkers: 4,
      shutdownDeadlineMs: -1,
      backends: { "in-process": fakeBackend } as SupervisorConfig["backends"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });
});

describe("workerId", () => {
  it("preserves string value in branded cast", () => {
    const id = workerId("w-1");
    expect(id).toBe(workerId("w-1"));
    expect(String(id)).toBe("w-1");
  });
});

describe("validateBackgroundSessionRecord", () => {
  const baseRecord: BackgroundSessionRecord = {
    workerId: workerId("w-1"),
    agentId: agentId("researcher"),
    pid: 12345,
    status: "running",
    startedAt: 1_700_000_000_000,
    logPath: "/tmp/logs/w-1.log",
    command: ["bun", "run", "worker.ts"],
    backendKind: "subprocess",
  };

  it("accepts a well-formed record", () => {
    const result = validateBackgroundSessionRecord(baseRecord);
    expect(result.ok).toBe(true);
  });

  it("rejects empty workerId", () => {
    const result = validateBackgroundSessionRecord({ ...baseRecord, workerId: workerId("") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  it("rejects empty agentId", () => {
    const result = validateBackgroundSessionRecord({ ...baseRecord, agentId: agentId("") });
    expect(result.ok).toBe(false);
  });

  it("rejects non-finite startedAt", () => {
    const result = validateBackgroundSessionRecord({ ...baseRecord, startedAt: Number.NaN });
    expect(result.ok).toBe(false);
  });

  it("rejects negative startedAt", () => {
    const result = validateBackgroundSessionRecord({ ...baseRecord, startedAt: -1 });
    expect(result.ok).toBe(false);
  });

  it("rejects empty command", () => {
    const result = validateBackgroundSessionRecord({ ...baseRecord, command: [] });
    expect(result.ok).toBe(false);
  });

  it("rejects non-finite pid", () => {
    const result = validateBackgroundSessionRecord({
      ...baseRecord,
      pid: Number.POSITIVE_INFINITY,
    });
    expect(result.ok).toBe(false);
  });
});
