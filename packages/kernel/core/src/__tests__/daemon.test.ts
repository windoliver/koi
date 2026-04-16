import { describe, expect, it } from "bun:test";
import type { SupervisorConfig, WorkerBackend } from "../daemon.js";
import { validateSupervisorConfig } from "../daemon.js";

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
});
