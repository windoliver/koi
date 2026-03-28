/**
 * Command routes unit tests.
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, KoiErrorCode, Result } from "@koi/core";
import { agentId } from "@koi/core";
import type { CommandDispatcher, DispatchAgentResponse } from "@koi/dashboard-types";
import {
  handleAddTask,
  handleCancelTask,
  handleDemoteBrick,
  handleDispatchAgent,
  handleListMailbox,
  handlePromoteBrick,
  handleQuarantineBrick,
  handleResumeAgent,
  handleRetryDeadLetter,
  handleSuspendAgent,
  handleTerminateAgentCmd,
  handleUpdateTask,
} from "./commands.js";

function ok(): Result<void, KoiError> {
  return { ok: true, value: undefined };
}

function err(code: KoiErrorCode, message: string): Result<void, KoiError> {
  return {
    ok: false,
    error: { code, message, retryable: false, context: {} },
  };
}

function createMockCommands(overrides?: Partial<CommandDispatcher>): CommandDispatcher {
  return {
    suspendAgent: () => ok(),
    resumeAgent: () => ok(),
    terminateAgent: () => ok(),
    retryDeadLetter: () => ({ ok: true as const, value: true }),
    listMailbox: () => ({ ok: true as const, value: [] }),
    ...overrides,
  };
}

function makeReq(url: string): Request {
  return new Request(`http://localhost${url}`, { method: "POST" });
}

describe("handleSuspendAgent", () => {
  test("returns 200 on success", async () => {
    const commands = createMockCommands();
    const res = await handleSuspendAgent(makeReq("/cmd/agents/a1/suspend"), { id: "a1" }, commands);
    expect(res.status).toBe(200);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands();
    const res = await handleSuspendAgent(makeReq("/cmd/agents//suspend"), {}, commands);
    expect(res.status).toBe(400);
  });

  test("returns 404 on NOT_FOUND error", async () => {
    const commands = createMockCommands({
      suspendAgent: () => err("NOT_FOUND", "Agent not found"),
    });
    const res = await handleSuspendAgent(makeReq("/cmd/agents/x/suspend"), { id: "x" }, commands);
    expect(res.status).toBe(404);
  });
});

describe("handleResumeAgent", () => {
  test("returns 200 on success", async () => {
    const commands = createMockCommands();
    const res = await handleResumeAgent(makeReq("/cmd/agents/a1/resume"), { id: "a1" }, commands);
    expect(res.status).toBe(200);
  });
});

describe("handleTerminateAgentCmd", () => {
  test("returns 200 on success", async () => {
    const commands = createMockCommands();
    const res = await handleTerminateAgentCmd(
      makeReq("/cmd/agents/a1/terminate"),
      { id: "a1" },
      commands,
    );
    expect(res.status).toBe(200);
  });
});

describe("handleRetryDeadLetter", () => {
  test("returns 200 on success", async () => {
    const commands = createMockCommands();
    const res = await handleRetryDeadLetter(
      makeReq("/cmd/events/dlq/dl1/retry"),
      { id: "dl1" },
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 501 when not implemented", async () => {
    const base = createMockCommands();
    const { retryDeadLetter: _, ...withoutRetry } = base;
    const res = await handleRetryDeadLetter(
      makeReq("/cmd/events/dlq/dl1/retry"),
      { id: "dl1" },
      withoutRetry as CommandDispatcher,
    );
    expect(res.status).toBe(501);
  });
});

describe("handleListMailbox", () => {
  test("returns messages", async () => {
    const commands = createMockCommands({
      listMailbox: () => ({
        ok: true as const,
        value: [
          {
            id: "m1",
            from: agentId("a1"),
            to: agentId("a2"),
            content: "hello",
            timestamp: Date.now(),
          },
        ],
      }),
    });
    const res = await handleListMailbox(
      makeReq("/cmd/mailbox/a1/list"),
      { agentId: "a1" },
      commands,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readonly data: readonly unknown[] };
    expect(body.data).toHaveLength(1);
  });

  test("returns 501 when not implemented", async () => {
    const base = createMockCommands();
    const { listMailbox: _, ...withoutMailbox } = base;
    const res = await handleListMailbox(
      makeReq("/cmd/mailbox/a1/list"),
      { agentId: "a1" },
      withoutMailbox as CommandDispatcher,
    );
    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// handleDispatchAgent
// ---------------------------------------------------------------------------

function makeJsonReq(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleDispatchAgent", () => {
  test("returns 200 with agentId on success", async () => {
    const commands = createMockCommands({
      dispatchAgent: (req) => ({
        ok: true as const,
        value: { agentId: agentId("new-1"), name: req.name },
      }),
    });
    const res = await handleDispatchAgent(
      makeJsonReq("/cmd/agents/dispatch", { name: "my-agent" }),
      {},
      commands,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readonly data: DispatchAgentResponse };
    expect(body.data.agentId).toBe(agentId("new-1"));
    expect(body.data.name).toBe("my-agent");
  });

  test("returns 200 with manifest and message", async () => {
    let capturedReq: unknown;
    const commands = createMockCommands({
      dispatchAgent: (req) => {
        capturedReq = req;
        return { ok: true as const, value: { agentId: agentId("new-2"), name: req.name } };
      },
    });
    const res = await handleDispatchAgent(
      makeJsonReq("/cmd/agents/dispatch", {
        name: "agent-2",
        manifest: "path/to/manifest.yaml",
        message: "Hello agent",
      }),
      {},
      commands,
    );
    expect(res.status).toBe(200);
    const req = capturedReq as { name: string; manifest?: string; message?: string };
    expect(req.manifest).toBe("path/to/manifest.yaml");
    expect(req.message).toBe("Hello agent");
  });

  test("returns 501 when dispatchAgent is not implemented", async () => {
    const commands = createMockCommands();
    // dispatchAgent is not set in createMockCommands
    const res = await handleDispatchAgent(
      makeJsonReq("/cmd/agents/dispatch", { name: "test" }),
      {},
      commands,
    );
    expect(res.status).toBe(501);
  });

  test("returns 400 when name is missing", async () => {
    const commands = createMockCommands({
      dispatchAgent: () => ({
        ok: true as const,
        value: { agentId: agentId("x"), name: "x" },
      }),
    });
    const res = await handleDispatchAgent(makeJsonReq("/cmd/agents/dispatch", {}), {}, commands);
    expect(res.status).toBe(400);
  });

  test("returns 400 when name is empty string", async () => {
    const commands = createMockCommands({
      dispatchAgent: () => ({
        ok: true as const,
        value: { agentId: agentId("x"), name: "x" },
      }),
    });
    const res = await handleDispatchAgent(
      makeJsonReq("/cmd/agents/dispatch", { name: "   " }),
      {},
      commands,
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid JSON body", async () => {
    const commands = createMockCommands({
      dispatchAgent: () => ({
        ok: true as const,
        value: { agentId: agentId("x"), name: "x" },
      }),
    });
    const req = new Request("http://localhost/cmd/agents/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await handleDispatchAgent(req, {}, commands);
    expect(res.status).toBe(400);
  });

  test("returns 409 on CONFLICT error", async () => {
    const commands = createMockCommands({
      dispatchAgent: () => ({
        ok: false as const,
        error: {
          code: "CONFLICT" as const,
          message: "Agent already exists",
          retryable: false,
          context: {},
        },
      }),
    });
    const res = await handleDispatchAgent(
      makeJsonReq("/cmd/agents/dispatch", { name: "dup" }),
      {},
      commands,
    );
    expect(res.status).toBe(409);
  });

  test("returns 404 on NOT_FOUND error", async () => {
    const commands = createMockCommands({
      dispatchAgent: () => ({
        ok: false as const,
        error: {
          code: "NOT_FOUND" as const,
          message: "Manifest not found",
          retryable: false,
          context: {},
        },
      }),
    });
    const res = await handleDispatchAgent(
      makeJsonReq("/cmd/agents/dispatch", { name: "agent", manifest: "missing.yaml" }),
      {},
      commands,
    );
    expect(res.status).toBe(404);
  });

  test("trims whitespace from name", async () => {
    let capturedName: string | undefined;
    const commands = createMockCommands({
      dispatchAgent: (req) => {
        capturedName = req.name;
        return { ok: true as const, value: { agentId: agentId("x"), name: req.name } };
      },
    });
    await handleDispatchAgent(
      makeJsonReq("/cmd/agents/dispatch", { name: "  padded  " }),
      {},
      commands,
    );
    expect(capturedName).toBe("padded");
  });
});

// ---------------------------------------------------------------------------
// Brick lifecycle commands (promote / demote / quarantine)
// ---------------------------------------------------------------------------

describe("handlePromoteBrick", () => {
  test("returns 200 on success", async () => {
    const commands = createMockCommands({ promoteBrick: () => ok() });
    const res = await handlePromoteBrick(
      makeReq("/cmd/forge/bricks/b1/promote"),
      { id: "b1" },
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands({ promoteBrick: () => ok() });
    const res = await handlePromoteBrick(makeReq("/cmd/forge/bricks//promote"), {}, commands);
    expect(res.status).toBe(400);
  });

  test("returns 501 when not implemented", async () => {
    const commands = createMockCommands();
    const res = await handlePromoteBrick(
      makeReq("/cmd/forge/bricks/b1/promote"),
      { id: "b1" },
      commands,
    );
    expect(res.status).toBe(501);
  });

  test("returns 404 on NOT_FOUND error", async () => {
    const commands = createMockCommands({
      promoteBrick: () => err("NOT_FOUND", "Brick not found"),
    });
    const res = await handlePromoteBrick(
      makeReq("/cmd/forge/bricks/x/promote"),
      { id: "x" },
      commands,
    );
    expect(res.status).toBe(404);
  });
});

describe("handleDemoteBrick", () => {
  test("returns 200 on success", async () => {
    const commands = createMockCommands({ demoteBrick: () => ok() });
    const res = await handleDemoteBrick(
      makeReq("/cmd/forge/bricks/b1/demote"),
      { id: "b1" },
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands({ demoteBrick: () => ok() });
    const res = await handleDemoteBrick(makeReq("/cmd/forge/bricks//demote"), {}, commands);
    expect(res.status).toBe(400);
  });

  test("returns 501 when not implemented", async () => {
    const commands = createMockCommands();
    const res = await handleDemoteBrick(
      makeReq("/cmd/forge/bricks/b1/demote"),
      { id: "b1" },
      commands,
    );
    expect(res.status).toBe(501);
  });
});

describe("handleQuarantineBrick", () => {
  test("returns 200 on success", async () => {
    const commands = createMockCommands({ quarantineBrick: () => ok() });
    const res = await handleQuarantineBrick(
      makeReq("/cmd/forge/bricks/b1/quarantine"),
      { id: "b1" },
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands({ quarantineBrick: () => ok() });
    const res = await handleQuarantineBrick(makeReq("/cmd/forge/bricks//quarantine"), {}, commands);
    expect(res.status).toBe(400);
  });

  test("returns 501 when not implemented", async () => {
    const commands = createMockCommands();
    const res = await handleQuarantineBrick(
      makeReq("/cmd/forge/bricks/b1/quarantine"),
      { id: "b1" },
      commands,
    );
    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// Task board mutations (add / update / cancel)
// ---------------------------------------------------------------------------

describe("handleAddTask", () => {
  test("returns 200 on success", async () => {
    const commands = createMockCommands({ addTask: () => ok() });
    const res = await handleAddTask(
      makeJsonReq("/cmd/tasks/add", { id: "task-1", description: "Do something" }),
      {},
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands({ addTask: () => ok() });
    const res = await handleAddTask(
      makeJsonReq("/cmd/tasks/add", { description: "No id" }),
      {},
      commands,
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when description is missing", async () => {
    const commands = createMockCommands({ addTask: () => ok() });
    const res = await handleAddTask(makeJsonReq("/cmd/tasks/add", { id: "task-1" }), {}, commands);
    expect(res.status).toBe(400);
  });

  test("returns 501 when not implemented", async () => {
    const commands = createMockCommands();
    const res = await handleAddTask(
      makeJsonReq("/cmd/tasks/add", { id: "task-1", description: "Test" }),
      {},
      commands,
    );
    expect(res.status).toBe(501);
  });
});

describe("handleUpdateTask", () => {
  test("returns 200 on success", async () => {
    const commands = createMockCommands({ updateTask: () => ok() });
    const res = await handleUpdateTask(
      makeJsonReq("/cmd/tasks/t1/update", { description: "Updated" }),
      { id: "t1" },
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands({ updateTask: () => ok() });
    const res = await handleUpdateTask(
      makeJsonReq("/cmd/tasks//update", { description: "Updated" }),
      {},
      commands,
    );
    expect(res.status).toBe(400);
  });

  test("returns 501 when not implemented", async () => {
    const commands = createMockCommands();
    const res = await handleUpdateTask(
      makeJsonReq("/cmd/tasks/t1/update", { description: "Updated" }),
      { id: "t1" },
      commands,
    );
    expect(res.status).toBe(501);
  });
});

describe("handleCancelTask", () => {
  test("returns 200 on success", async () => {
    const commands = createMockCommands({ cancelTask: () => ok() });
    const res = await handleCancelTask(
      makeJsonReq("/cmd/tasks/t1/cancel", { reason: "Prod freeze" }),
      { id: "t1" },
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands({ cancelTask: () => ok() });
    const res = await handleCancelTask(
      makeJsonReq("/cmd/tasks//cancel", { reason: "Prod freeze" }),
      {},
      commands,
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when reason is missing", async () => {
    const commands = createMockCommands({ cancelTask: () => ok() });
    const res = await handleCancelTask(
      makeJsonReq("/cmd/tasks/t1/cancel", {}),
      { id: "t1" },
      commands,
    );
    expect(res.status).toBe(400);
  });

  test("returns 501 when not implemented", async () => {
    const commands = createMockCommands();
    const res = await handleCancelTask(
      makeJsonReq("/cmd/tasks/t1/cancel", { reason: "Prod freeze" }),
      { id: "t1" },
      commands,
    );
    expect(res.status).toBe(501);
  });
});
