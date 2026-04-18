import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentId, type ApprovalHandler, agentId as agentIdBrand } from "@koi/core";
import type { BashToolHandle } from "@koi/tools-bash";
import {
  AGENT_ID_HOST_KEY,
  APPROVAL_HANDLER_HOST_KEY,
  BACKGROUND_SUBPROCESSES_HOST_KEY,
  BASH_ELICIT_AUTO_APPROVE_HOST_KEY,
  EXECUTION_EXPORTS,
  executionStack,
  TASK_BOARD_TOOLS_HOST_KEY,
} from "./execution.js";

// ---------------------------------------------------------------------------
// --yolo bash elicit bypass regression (commit 95fa74534)
//
// The Bash AST walker's `too-complex` path calls `approvalHandler` directly,
// bypassing the permissions middleware. Under --yolo the permission backend
// allows all tools, so the elicit fallback MUST also auto-approve or the
// user sees a prompt for commands the walker cannot statically classify
// (e.g. `cmd && cmd 2>&1` — list + redirected_statement).
// ---------------------------------------------------------------------------

async function activateWithYolo(options: {
  readonly yolo: boolean;
  readonly approvalHandler: ApprovalHandler;
}): Promise<{ bashHandle: BashToolHandle }> {
  const ctx = {
    cwd: await mkdtemp(join(tmpdir(), "koi-exec-yolo-")),
    hostId: "koi-test",
    host: {
      [APPROVAL_HANDLER_HOST_KEY]: options.approvalHandler,
      [AGENT_ID_HOST_KEY]: agentIdBrand("test-agent") as AgentId,
      [BACKGROUND_SUBPROCESSES_HOST_KEY]: false,
      [TASK_BOARD_TOOLS_HOST_KEY]: false,
      ...(options.yolo ? { [BASH_ELICIT_AUTO_APPROVE_HOST_KEY]: true } : {}),
    },
  };
  const contribution = await executionStack.activate(ctx);
  const bashHandle = contribution.exports?.[EXECUTION_EXPORTS.bashHandle] as BashToolHandle;
  return { bashHandle };
}

describe("executionStack — --yolo bash elicit bypass", () => {
  test("yolo=true: too-complex bash command does NOT invoke approvalHandler", async () => {
    // let: mutation tracks call count; resets implicitly per test
    let calls = 0;
    const approvalHandler: ApprovalHandler = async () => {
      calls++;
      return { kind: "deny", reason: "should not be called" };
    };
    const { bashHandle } = await activateWithYolo({ yolo: true, approvalHandler });

    // `echo $USER` is too-complex (nodeType: simple_expansion) — walker
    // cannot prove it safe, so the elicit fallback fires. Under yolo the
    // callback must short-circuit to allow without calling the handler.
    const result = await bashHandle.tool.execute({ command: "echo $USER" });

    expect(calls).toBe(0);
    // Bash actually runs → success shape (stdout/exitCode), not blocked shape
    expect("error" in (result as object)).toBe(false);
  });

  test("yolo=false: too-complex bash command DOES invoke approvalHandler", async () => {
    // let: mutation tracks call count
    let calls = 0;
    const approvalHandler: ApprovalHandler = async () => {
      calls++;
      return { kind: "allow" };
    };
    const { bashHandle } = await activateWithYolo({ yolo: false, approvalHandler });

    await bashHandle.tool.execute({ command: "echo $USER" });

    expect(calls).toBe(1);
  });

  test("yolo=true: hard-deny patterns still blocked (defense in depth)", async () => {
    // let: must be reachable from assertion scope
    let calls = 0;
    const approvalHandler: ApprovalHandler = async () => {
      calls++;
      return { kind: "allow" };
    };
    const { bashHandle } = await activateWithYolo({ yolo: true, approvalHandler });

    // Backslash-in-word is a hard-deny nodeType — bypasses the elicit
    // callback entirely and fails closed. Yolo must not change this.
    const result = await bashHandle.tool.execute({ command: "cat \\/etc\\/passwd" });

    expect(calls).toBe(0);
    expect("error" in (result as object)).toBe(true);
  });
});
