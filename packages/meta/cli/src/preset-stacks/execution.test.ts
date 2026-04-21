import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentId,
  type ApprovalHandler,
  agentId as agentIdBrand,
  type TaskItemId,
  taskItemId,
} from "@koi/core";
import { type BashToolHandle, createBashOutputBuffer } from "@koi/tools-bash";
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

  test("yolo=true: list + redirect command (the original bug) does NOT prompt", async () => {
    // The reported bug was `cd /foo && bun test 2>&1` — the walker
    // classifies this as a `list` with an embedded `redirected_statement`
    // and cannot statically prove it safe. Under yolo the elicit
    // callback must still short-circuit for this specific AST shape.
    // let: mutation tracks call count
    let calls = 0;
    const approvalHandler: ApprovalHandler = async () => {
      calls++;
      return { kind: "deny", reason: "should not be called" };
    };
    const { bashHandle } = await activateWithYolo({ yolo: true, approvalHandler });

    const result = await bashHandle.tool.execute({ command: "echo hi && ls 2>&1" });

    expect(calls).toBe(0);
    expect("error" in (result as object)).toBe(false);
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

// ---------------------------------------------------------------------------
// markOutputBufferTerminal — pre-reset finalizer guard (Fix 2)
//
// A background task spawned in session N may exit AFTER onResetSession fires
// for session N+1. The finalizer calls markOutputBufferTerminal(oldTaskId).
// The guard must detect the stale call and no-op, preventing the old task from
// corrupting the new session's terminalBufferOrder or bashOutputBuffersRef.
//
// We test the guard logic in isolation (the callback is a closure, not exported)
// by replicating the ref-swap contract: after reset, both refs are fresh empty
// collections. A stale task ID (absent from both) must be silently dropped.
// ---------------------------------------------------------------------------

describe("markOutputBufferTerminal — pre-reset finalizer guard", () => {
  test("late finalizer from pre-reset session does not corrupt new session buffer map", () => {
    // Replicate the guard logic from execution.ts in isolation so we can assert
    // on the contract without wiring the full preset stack.
    const MAX_BYTES = 1_000_000;
    const TERMINAL_BUFFER_RETAIN = 32;

    // Session 1 state
    let bashOutputBuffersRef: {
      current: Map<TaskItemId, ReturnType<typeof createBashOutputBuffer>>;
    } = {
      current: new Map(),
    };
    let everHadBufferRef: { current: Set<TaskItemId> } = { current: new Set() };
    let terminalBufferOrder: TaskItemId[] = [];

    // Allocate a buffer for taskA in session 1
    const taskA = taskItemId("task_a");
    const bufA = createBashOutputBuffer({ maxBytes: MAX_BYTES });
    bashOutputBuffersRef.current.set(taskA, bufA);
    everHadBufferRef.current.add(taskA);

    // Simulate onResetSession — swap both refs
    bashOutputBuffersRef = { current: new Map() };
    everHadBufferRef = { current: new Set() };
    terminalBufferOrder = [];

    // Allocate a buffer for taskB in session 2
    const taskB = taskItemId("task_b");
    const bufB = createBashOutputBuffer({ maxBytes: MAX_BYTES });
    bashOutputBuffersRef.current.set(taskB, bufB);
    everHadBufferRef.current.add(taskB);

    // Guard logic (mirrors execution.ts markOutputBufferTerminal)
    function markTerminal(id: TaskItemId): void {
      const currentBuffers = bashOutputBuffersRef.current;
      const currentEverHad = everHadBufferRef.current;
      if (!currentBuffers.has(id) && !currentEverHad.has(id)) {
        return; // stale finalizer — no-op
      }
      terminalBufferOrder.push(id);
      if (terminalBufferOrder.length > TERMINAL_BUFFER_RETAIN) {
        const evictId = terminalBufferOrder.shift();
        if (evictId !== undefined) {
          currentBuffers.delete(evictId);
        }
      }
    }

    // Late finalizer from session 1 fires with taskA (stale)
    markTerminal(taskA);

    // taskA must NOT appear in the new session's terminalBufferOrder
    expect(terminalBufferOrder).not.toContain(taskA);
    // taskB's buffer must still be present (not accidentally evicted)
    expect(bashOutputBuffersRef.current.has(taskB)).toBe(true);
    // terminalBufferOrder is empty — no corruption occurred
    expect(terminalBufferOrder).toHaveLength(0);
  });

  test("current-session finalizer still correctly records and evicts", () => {
    const MAX_BYTES = 1_000_000;
    const TERMINAL_BUFFER_RETAIN = 2; // small limit to force eviction

    // Refs are mutated via .current — not reassigned — so const is correct.
    const bashOutputBuffersRef: {
      current: Map<TaskItemId, ReturnType<typeof createBashOutputBuffer>>;
    } = {
      current: new Map(),
    };
    const everHadBufferRef: { current: Set<TaskItemId> } = { current: new Set() };
    // Array is mutated in place (push/shift) — not reassigned — so const is correct.
    const terminalBufferOrder: TaskItemId[] = [];

    function markTerminal(id: TaskItemId): void {
      const currentBuffers = bashOutputBuffersRef.current;
      const currentEverHad = everHadBufferRef.current;
      if (!currentBuffers.has(id) && !currentEverHad.has(id)) {
        return;
      }
      terminalBufferOrder.push(id);
      if (terminalBufferOrder.length > TERMINAL_BUFFER_RETAIN) {
        const evictId = terminalBufferOrder.shift();
        if (evictId !== undefined) {
          currentBuffers.delete(evictId);
        }
      }
    }

    // Allocate three buffers in current session
    const ids = [taskItemId("t1"), taskItemId("t2"), taskItemId("t3")] as const;
    for (const id of ids) {
      bashOutputBuffersRef.current.set(id, createBashOutputBuffer({ maxBytes: MAX_BYTES }));
      everHadBufferRef.current.add(id);
    }

    // Mark all three terminal — TERMINAL_BUFFER_RETAIN=2, so t1 should be evicted
    markTerminal(ids[0]);
    markTerminal(ids[1]);
    markTerminal(ids[2]); // triggers eviction of ids[0]

    expect(terminalBufferOrder).toHaveLength(2);
    expect(terminalBufferOrder).toContain(ids[1]);
    expect(terminalBufferOrder).toContain(ids[2]);
    // ids[0] was evicted from the buffer map
    expect(bashOutputBuffersRef.current.has(ids[0])).toBe(false);
    // ids[1] and ids[2] are still in the map (within TERMINAL_BUFFER_RETAIN)
    expect(bashOutputBuffersRef.current.has(ids[1])).toBe(true);
    expect(bashOutputBuffersRef.current.has(ids[2])).toBe(true);
  });
});
