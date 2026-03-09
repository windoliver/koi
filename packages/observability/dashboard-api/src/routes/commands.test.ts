/**
 * Command routes unit tests.
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, KoiErrorCode, Result } from "@koi/core";
import { agentId } from "@koi/core";
import type { CommandDispatcher } from "@koi/dashboard-types";
import {
  handleListMailbox,
  handleResumeAgent,
  handleRetryDeadLetter,
  handleSuspendAgent,
  handleTerminateAgentCmd,
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
    retryDeadLetter: () => ok(),
    listMailbox: () => [],
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
      listMailbox: () => [
        {
          id: "m1",
          from: agentId("a1"),
          to: agentId("a2"),
          content: "hello",
          timestamp: Date.now(),
        },
      ],
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
