/**
 * Tests for the ACP approval bridge.
 */

import { describe, expect, test } from "bun:test";
import type { SessionRequestPermissionParams } from "@koi/acp-protocol";
import type { ApprovalHandler } from "@koi/core";
import { resolvePermission } from "./approval-bridge.js";

const BASE_PARAMS: SessionRequestPermissionParams = {
  sessionId: "sess_abc",
  toolCall: {
    toolCallId: "tc_1",
    title: "Write file",
    kind: "edit",
    status: "pending",
  },
  options: [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
    { optionId: "deny-once", name: "Deny", kind: "reject_once" },
  ],
};

describe("resolvePermission — no handler (headless mode)", () => {
  test("allows when allow option is available", async () => {
    const result = await resolvePermission(BASE_PARAMS, undefined);
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") {
      expect(result.optionId).toBe("allow-once");
    }
  });

  test("cancels when no allow option is available", async () => {
    const denyOnlyParams: SessionRequestPermissionParams = {
      ...BASE_PARAMS,
      options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
    };
    const result = await resolvePermission(denyOnlyParams, undefined);
    expect(result.outcome).toBe("cancelled");
  });

  test("cancels when options is undefined", async () => {
    const noOptionsParams: SessionRequestPermissionParams = {
      ...BASE_PARAMS,
      options: undefined,
    };
    const result = await resolvePermission(noOptionsParams, undefined);
    expect(result.outcome).toBe("cancelled");
  });
});

describe("resolvePermission — with handler: allow decision", () => {
  test("selects first allow option when handler returns allow", async () => {
    const handler: ApprovalHandler = async () => ({ kind: "allow" });
    const result = await resolvePermission(BASE_PARAMS, handler);
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") {
      expect(result.optionId).toBe("allow-once");
    }
  });

  test("cancels when handler allows but no allow option available", async () => {
    const handler: ApprovalHandler = async () => ({ kind: "allow" });
    const denyOnlyParams: SessionRequestPermissionParams = {
      ...BASE_PARAMS,
      options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
    };
    const result = await resolvePermission(denyOnlyParams, handler);
    expect(result.outcome).toBe("cancelled");
  });
});

describe("resolvePermission — with handler: deny decision", () => {
  test("selects first reject option when handler returns deny", async () => {
    const handler: ApprovalHandler = async () => ({
      kind: "deny",
      reason: "Not allowed",
    });
    const result = await resolvePermission(BASE_PARAMS, handler);
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") {
      expect(result.optionId).toBe("deny-once");
    }
  });

  test("cancels when handler denies but no reject option available", async () => {
    const handler: ApprovalHandler = async () => ({
      kind: "deny",
      reason: "Not allowed",
    });
    const allowOnlyParams: SessionRequestPermissionParams = {
      ...BASE_PARAMS,
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    };
    const result = await resolvePermission(allowOnlyParams, handler);
    expect(result.outcome).toBe("cancelled");
  });
});

describe("resolvePermission — with handler: modify decision", () => {
  test("treats modify as allow (ACP does not support input modification)", async () => {
    const handler: ApprovalHandler = async () => ({
      kind: "modify",
      updatedInput: { key: "modified" },
    });
    const result = await resolvePermission(BASE_PARAMS, handler);
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") {
      expect(result.optionId).toBe("allow-once");
    }
  });
});

describe("resolvePermission — fail-closed on handler error", () => {
  test("returns cancelled when handler throws (fail-closed)", async () => {
    const handler: ApprovalHandler = async () => {
      throw new Error("Approval service unavailable");
    };
    const result = await resolvePermission(BASE_PARAMS, handler);
    expect(result.outcome).toBe("cancelled");
  });
});
