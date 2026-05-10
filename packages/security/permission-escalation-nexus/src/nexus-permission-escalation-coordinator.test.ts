import { describe, expect, test } from "bun:test";
import type { EscalationDecision, KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createNexusPermissionEscalationCoordinator } from "./nexus-permission-escalation-coordinator.js";

function ok<T>(value: T): Result<T, KoiError> {
  return { ok: true, value };
}

describe("createNexusPermissionEscalationCoordinator", () => {
  test("pollOnce resolves a pending request through the supplied callback", async () => {
    const sent: Record<string, unknown>[] = [];
    const transport: NexusTransport = {
      kind: "http",
      call: async <T>(method: string, params: Record<string, unknown>) => {
        if (method === "ipc.list") {
          return ok({
            messages: [
              {
                id: "msg-1",
                from: "agent:worker",
                to: "agent:leader",
                kind: "request",
                type: "permission_escalation_request",
                payload: {
                  kind: "permission_escalation_request",
                  request: {
                    requestId: "req-1",
                    agentId: "agent:worker",
                    requestedGrants: ["fs:write"],
                    purposeStatement: "Need to patch a file",
                    expiresAt: 60_000,
                  },
                  workerAgentId: "agent:worker",
                  coordinatorAgentId: "agent:leader",
                  createdAt: 0,
                  expiresAt: 60_000,
                },
                createdAt: "2026-05-09T00:00:00.000Z",
              },
            ],
          } as T);
        }
        if (method === "ipc.send") {
          sent.push(params);
          return ok({ id: "decision-1", ...params } as T);
        }
        throw new Error(`unexpected method ${method}`);
      },
      close: () => {},
    };

    const coordinator = createNexusPermissionEscalationCoordinator({
      transport,
      coordinatorAgentId: "agent:leader" as never,
      clock: () => 0,
    });

    const count = await coordinator.pollOnce(async () => ({
      decision: "approved",
      grantedGrants: ["fs:write"],
    }));

    expect(count).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.from).toBe("agent:leader");
    expect(sent[0]?.to).toBe("agent:worker");
    expect(sent[0]?.type).toBe("permission_escalation_decision");
  });

  test("uses a non-default mailbox prefix when configured", async () => {
    const methods: string[] = [];
    const transport: NexusTransport = {
      kind: "http",
      call: async <T>(method: string) => {
        methods.push(method);
        if (method === "perm.list") {
          return ok({ messages: [] } as T);
        }
        throw new Error(`unexpected method ${method}`);
      },
      close: () => {},
    };

    const coordinator = createNexusPermissionEscalationCoordinator({
      transport,
      coordinatorAgentId: "agent:leader" as never,
      requestMethodPrefix: "perm",
      clock: () => 0,
    });

    const count = await coordinator.pollOnce(async () => ({
      decision: "approved",
      grantedGrants: ["fs:write"],
    }));

    expect(count).toBe(0);
    expect(methods).toEqual(["perm.list"]);
  });

  test("expired requests emit an expired decision without calling resolve", async () => {
    let called = false;
    const sent: Record<string, unknown>[] = [];
    const transport: NexusTransport = {
      kind: "http",
      call: async <T>(method: string, params: Record<string, unknown>) => {
        if (method === "ipc.list") {
          return ok({
            messages: [
              {
                id: "msg-expired",
                from: "agent:worker",
                to: "agent:leader",
                kind: "request",
                type: "permission_escalation_request",
                payload: {
                  kind: "permission_escalation_request",
                  request: {
                    requestId: "req-expired",
                    agentId: "agent:worker",
                    requestedGrants: ["fs:write"],
                    purposeStatement: "Late request",
                    expiresAt: 5,
                  },
                  workerAgentId: "agent:worker",
                  coordinatorAgentId: "agent:leader",
                  createdAt: 0,
                  expiresAt: 5,
                },
                createdAt: "2026-05-09T00:00:00.000Z",
              },
            ],
          } as T);
        }
        if (method === "ipc.send") {
          sent.push(params);
          return ok({ id: "decision-expired", ...params } as T);
        }
        throw new Error(`unexpected method ${method}`);
      },
      close: () => {},
    };

    const coordinator = createNexusPermissionEscalationCoordinator({
      transport,
      coordinatorAgentId: "agent:leader" as never,
      clock: () => 10,
    });

    const count = await coordinator.pollOnce(async () => {
      called = true;
      return { decision: "approved", grantedGrants: ["fs:write"] };
    });

    expect(count).toBe(1);
    expect(called).toBe(false);
    expect(sent).toHaveLength(1);
    expect((sent[0]?.payload as { decision?: EscalationDecision } | undefined)?.decision).toEqual({
      decision: "expired",
      reason: "permission escalation timed out",
    });
  });

  test("slow approvals that expire mid-resolution downgrade to expired", async () => {
    const sent: Record<string, unknown>[] = [];
    let now = 0;
    const transport: NexusTransport = {
      kind: "http",
      call: async <T>(method: string, params: Record<string, unknown>) => {
        if (method === "ipc.list") {
          return ok({
            messages: [
              {
                id: "msg-slow",
                from: "agent:worker",
                to: "agent:leader",
                kind: "request",
                type: "permission_escalation_request",
                payload: {
                  kind: "permission_escalation_request",
                  request: {
                    requestId: "req-slow",
                    agentId: "agent:worker",
                    requestedGrants: ["fs:write"],
                    purposeStatement: "Need to patch a file",
                    expiresAt: 5,
                  },
                  workerAgentId: "agent:worker",
                  coordinatorAgentId: "agent:leader",
                  createdAt: 0,
                  expiresAt: 5,
                },
                createdAt: "2026-05-09T00:00:00.000Z",
              },
            ],
          } as T);
        }
        if (method === "ipc.send") {
          sent.push(params);
          return ok({ id: "decision-slow", ...params } as T);
        }
        throw new Error(`unexpected method ${method}`);
      },
      close: () => {},
    };

    const coordinator = createNexusPermissionEscalationCoordinator({
      transport,
      coordinatorAgentId: "agent:leader" as never,
      clock: () => now,
    });

    const count = await coordinator.pollOnce(async () => {
      now = 10;
      return { decision: "approved", grantedGrants: ["fs:write"] };
    });

    expect(count).toBe(1);
    expect((sent[0]?.payload as { decision?: EscalationDecision } | undefined)?.decision).toEqual({
      decision: "expired",
      reason: "permission escalation timed out",
    });
  });

  test("ignores malformed or mismatched request envelopes", async () => {
    const sent: Record<string, unknown>[] = [];
    const transport: NexusTransport = {
      kind: "http",
      call: async <T>(method: string, params: Record<string, unknown>) => {
        if (method === "ipc.list") {
          return ok({
            messages: [
              {
                id: "msg-foreign-envelope",
                from: "agent:spoofed",
                to: "agent:leader",
                kind: "request",
                type: "permission_escalation_request",
                payload: {
                  kind: "permission_escalation_request",
                  request: {
                    requestId: "req-foreign-envelope",
                    agentId: "agent:worker",
                    requestedGrants: ["fs:write"],
                    purposeStatement: "Need to patch a file",
                    expiresAt: 60_000,
                  },
                  workerAgentId: "agent:worker",
                  coordinatorAgentId: "agent:other",
                  createdAt: 0,
                  expiresAt: 60_000,
                },
                createdAt: "2026-05-09T00:00:00.000Z",
              },
              {
                id: "msg-malformed",
                from: "agent:worker",
                to: "agent:leader",
                kind: "request",
                type: "permission_escalation_request",
                payload: {},
                createdAt: "2026-05-09T00:00:00.000Z",
              },
              {
                id: "msg-valid",
                from: "agent:worker",
                to: "agent:leader",
                kind: "request",
                type: "permission_escalation_request",
                payload: {
                  kind: "permission_escalation_request",
                  request: {
                    requestId: "req-valid",
                    agentId: "agent:worker",
                    requestedGrants: ["fs:write"],
                    purposeStatement: "Need to patch a file",
                    expiresAt: 60_000,
                  },
                  workerAgentId: "agent:worker",
                  coordinatorAgentId: "agent:leader",
                  createdAt: 0,
                  expiresAt: 60_000,
                },
                createdAt: "2026-05-09T00:00:00.000Z",
              },
            ],
          } as T);
        }
        if (method === "ipc.send") {
          sent.push(params);
          return ok({ id: "decision-1", ...params } as T);
        }
        throw new Error(`unexpected method ${method}`);
      },
      close: () => {},
    };

    const coordinator = createNexusPermissionEscalationCoordinator({
      transport,
      coordinatorAgentId: "agent:leader" as never,
      clock: () => 0,
    });

    const count = await coordinator.pollOnce(async () => ({
      decision: "approved",
      grantedGrants: ["fs:write"],
    }));

    expect(count).toBe(1);
    expect(sent).toHaveLength(1);
    expect((sent[0]?.payload as { requestId?: string } | undefined)?.requestId).toBe("req-valid");
  });

  test("does not re-resolve or re-send the same durable request on repeated polls", async () => {
    const sent: Record<string, unknown>[] = [];
    let resolveCalls = 0;
    const inboxMessages = [
      {
        id: "msg-1",
        from: "agent:worker",
        to: "agent:leader",
        kind: "request" as const,
        type: "permission_escalation_request",
        payload: {
          kind: "permission_escalation_request",
          request: {
            requestId: "req-1",
            agentId: "agent:worker",
            requestedGrants: ["fs:write"],
            purposeStatement: "Need to patch a file",
            expiresAt: 60_000,
          },
          workerAgentId: "agent:worker",
          coordinatorAgentId: "agent:leader",
          createdAt: 0,
          expiresAt: 60_000,
        },
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    ];
    const transport: NexusTransport = {
      kind: "http",
      call: async <T>(method: string, params: Record<string, unknown>) => {
        if (method === "ipc.list") {
          return ok({ messages: inboxMessages } as T);
        }
        if (method === "ipc.send") {
          sent.push(params);
          return ok({ id: `decision-${sent.length}`, ...params } as T);
        }
        throw new Error(`unexpected method ${method}`);
      },
      close: () => {},
    };

    const coordinator = createNexusPermissionEscalationCoordinator({
      transport,
      coordinatorAgentId: "agent:leader" as never,
      clock: () => 0,
    });

    const resolve = async (): Promise<EscalationDecision> => {
      resolveCalls += 1;
      return { decision: "approved", grantedGrants: ["fs:write"] };
    };

    const firstCount = await coordinator.pollOnce(resolve);
    const secondCount = await coordinator.pollOnce(resolve);

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(0);
    expect(resolveCalls).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
