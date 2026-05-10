import { describe, expect, test } from "bun:test";
import type { NexusTransport } from "@koi/nexus-client";
import {
  createNexusPermissionEscalation,
  createNexusPermissionEscalationCoordinator,
} from "./index.js";
import {
  validateNexusPermissionEscalationConfig,
  validateNexusPermissionEscalationCoordinatorConfig,
} from "./config.js";

function makeTransport(): NexusTransport {
  return {
    call: async () => ({ ok: true, value: {} }),
    close: () => {},
  };
}

describe("permission-escalation-nexus config", () => {
  test("accepts a minimal worker config", () => {
    const config = {
      transport: makeTransport(),
      agentId: "agent:worker" as never,
      coordinatorAgentId: "agent:leader" as never,
    };

    const result = validateNexusPermissionEscalationConfig(config);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(config);
    }
  });

  test("rejects a non-object config", () => {
    const result = validateNexusPermissionEscalationConfig(null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "VALIDATION",
        message: "config must be an object",
        retryable: false,
      });
    }
  });

  test("rejects a worker config without transport", () => {
    const result = validateNexusPermissionEscalationConfig({
      agentId: "agent:worker",
      coordinatorAgentId: "agent:leader",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("config.transport must be provided");
    }
  });

  test("rejects a worker config without agent ids", () => {
    const result = validateNexusPermissionEscalationConfig({
      transport: makeTransport(),
      agentId: "",
      coordinatorAgentId: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("config.agentId must be provided");
    }
  });

  test("rejects invalid worker option types", () => {
    const result = validateNexusPermissionEscalationConfig({
      transport: makeTransport(),
      agentId: "agent:worker",
      coordinatorAgentId: "agent:leader",
      requestMethodPrefix: "",
      pollIntervalMs: -1,
      clock: "now",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("config.requestMethodPrefix must be a non-empty string");
    }
  });

  test("rejects invalid coordinator config", () => {
    const result = validateNexusPermissionEscalationCoordinatorConfig({
      transport: { call: async () => ({ ok: true, value: {} }) },
      coordinatorAgentId: "",
      pollIntervalMs: -1,
      clock: "now",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("config.transport must be provided");
    }
  });

  test("index exports runtime entrypoints", () => {
    expect(typeof createNexusPermissionEscalation).toBe("function");
    expect(typeof createNexusPermissionEscalationCoordinator).toBe("function");
  });

  test("worker request fails closed on bound identity mismatch", async () => {
    const escalation = createNexusPermissionEscalation({
      transport: makeTransport(),
      agentId: "agent:worker" as never,
      coordinatorAgentId: "agent:leader" as never,
    });

    await expect(
      escalation.request({
        requestId: "req-1",
        agentId: "agent:other" as never,
        requestedGrants: ["fs:write"],
        purposeStatement: "Need to patch a file",
        expiresAt: Date.now() + 60_000,
      }),
    ).resolves.toEqual({
      decision: "rejected",
      reason: "permission escalation agentId does not match bound client identity",
    });
  });

  test("worker factory validates config eagerly", () => {
    expect(() =>
      createNexusPermissionEscalation({
        transport: makeTransport(),
        agentId: "" as never,
        coordinatorAgentId: "agent:leader" as never,
      }),
    ).toThrow("config.agentId must be provided");
  });

  test("coordinator stub throws not implemented yet and dispose is a no-op", async () => {
    const coordinator = createNexusPermissionEscalationCoordinator({
      transport: makeTransport(),
      coordinatorAgentId: "agent:leader" as never,
    });

    await expect(
      coordinator.pollOnce(async () => ({
        decision: "approved",
        grantedGrants: ["fs:write"],
      })),
    ).rejects.toThrow("createNexusPermissionEscalationCoordinator is not implemented yet");

    expect(() => coordinator.dispose()).not.toThrow();
  });

  test("coordinator factory validates config eagerly", () => {
    expect(() =>
      createNexusPermissionEscalationCoordinator({
        transport: makeTransport(),
        coordinatorAgentId: "" as never,
      }),
    ).toThrow("config.coordinatorAgentId must be provided");
  });
});
