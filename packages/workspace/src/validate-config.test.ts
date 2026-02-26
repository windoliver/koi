import { describe, expect, it } from "bun:test";
import type { AgentId, Result } from "@koi/core";
import type { ResolvedWorkspaceConfig, WorkspaceBackend, WorkspaceInfo } from "./types.js";
import { validateWorkspaceConfig } from "./validate-config.js";

const stubBackend: WorkspaceBackend = {
  name: "stub",
  create: async (
    _agentId: AgentId,
    _config: ResolvedWorkspaceConfig,
  ): Promise<Result<WorkspaceInfo>> => ({
    ok: true,
    value: { id: "x", path: "/tmp/x", createdAt: 0, metadata: {} },
  }),
  dispose: async () => ({ ok: true as const, value: undefined }),
  isHealthy: () => true,
};

describe("validateWorkspaceConfig", () => {
  it("returns ok with defaults when only backend is provided", () => {
    const result = validateWorkspaceConfig({ backend: stubBackend });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.cleanupPolicy).toBe("on_success");
    expect(result.value.config.cleanupTimeoutMs).toBe(5_000);
    expect(result.value.backend).toBe(stubBackend);
    expect(result.value.postCreate).toBeUndefined();
  });

  it("preserves explicit cleanupPolicy", () => {
    const result = validateWorkspaceConfig({ backend: stubBackend, cleanupPolicy: "always" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.cleanupPolicy).toBe("always");
  });

  it("preserves explicit cleanupTimeoutMs", () => {
    const result = validateWorkspaceConfig({ backend: stubBackend, cleanupTimeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.cleanupTimeoutMs).toBe(10_000);
  });

  it("preserves postCreate hook", () => {
    const hook = async (_ws: WorkspaceInfo): Promise<void> => {};
    const result = validateWorkspaceConfig({ backend: stubBackend, postCreate: hook });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.postCreate).toBe(hook);
  });

  it("returns error when backend is missing", () => {
    const result = validateWorkspaceConfig({} as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("backend");
  });

  it("returns error for invalid cleanupPolicy", () => {
    const result = validateWorkspaceConfig({
      backend: stubBackend,
      cleanupPolicy: "invalid" as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("cleanupPolicy");
  });

  it("returns error for non-positive cleanupTimeoutMs", () => {
    const result = validateWorkspaceConfig({ backend: stubBackend, cleanupTimeoutMs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("cleanupTimeoutMs");
  });

  it("returns error for NaN cleanupTimeoutMs", () => {
    const result = validateWorkspaceConfig({ backend: stubBackend, cleanupTimeoutMs: NaN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  it("returns error for Infinity cleanupTimeoutMs", () => {
    const result = validateWorkspaceConfig({ backend: stubBackend, cleanupTimeoutMs: Infinity });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });
});
