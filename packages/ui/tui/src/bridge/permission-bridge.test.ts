import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ApprovalDecision, ApprovalRequest } from "@koi/core/middleware";
import { createInitialState } from "../state/initial.js";
import type { TuiStore } from "../state/store.js";
import { createStore } from "../state/store.js";
import {
  createPermissionBridge,
  type PermissionBridge,
  resetRequestIdCounter,
} from "./permission-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    toolId: "bash",
    input: { cmd: "ls" },
    reason: "Tool requires approval",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let store: TuiStore;
let bridge: PermissionBridge;

beforeEach(() => {
  resetRequestIdCounter();
  store = createStore(createInitialState());
  bridge = createPermissionBridge({ store, timeoutMs: 100 }); // short timeout for tests
});

afterEach(() => {
  bridge.dispose();
});

// ---------------------------------------------------------------------------
// Happy path: handler → respond → Promise resolves
// ---------------------------------------------------------------------------

describe("permission bridge — happy path", () => {
  test("handler returns a Promise that resolves when respond is called with allow", async () => {
    const promise = bridge.handler(makeRequest());
    expect(bridge.pendingCount()).toBe(1);

    // Modal should be shown
    const state = store.getState();
    expect(state.modal?.kind).toBe("permission-prompt");
    if (state.modal?.kind === "permission-prompt") {
      expect(state.modal.prompt.toolId).toBe("bash");
      expect(state.modal.prompt.riskLevel).toBe("high"); // fail-closed default when no classifier
    }

    // Respond with allow
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";
    bridge.respond(requestId, { kind: "allow" });

    const decision = await promise;
    expect(decision).toEqual({ kind: "allow" });
    expect(bridge.pendingCount()).toBe(0);
  });

  test("handler resolves with deny decision", async () => {
    const promise = bridge.handler(makeRequest());
    const state = store.getState();
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";

    bridge.respond(requestId, { kind: "deny", reason: "not today" });

    const decision = await promise;
    expect(decision).toEqual({ kind: "deny", reason: "not today" });
  });

  test("handler resolves with always-allow decision", async () => {
    const promise = bridge.handler(makeRequest());
    const state = store.getState();
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";

    bridge.respond(requestId, { kind: "always-allow", scope: "session" });

    const decision = await promise;
    expect(decision).toEqual({ kind: "always-allow", scope: "session" });
  });

  test("modal is dismissed after respond", async () => {
    const promise = bridge.handler(makeRequest());
    const state = store.getState();
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";

    bridge.respond(requestId, { kind: "allow" });
    await promise;

    // Wait for microtask to flush store notification
    await new Promise<void>((r) => queueMicrotask(r));
    expect(store.getState().modal).toBeNull();
  });

  test("custom risk classifier is used", async () => {
    bridge.dispose();
    bridge = createPermissionBridge({
      store,
      timeoutMs: 100,
      classifyRisk: (req) => (req.toolId === "bash" ? "high" : "low"),
    });

    const promise = bridge.handler(makeRequest({ toolId: "bash" }));
    const state = store.getState();
    if (state.modal?.kind === "permission-prompt") {
      expect(state.modal.prompt.riskLevel).toBe("high");
    }

    bridge.respond(state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "", {
      kind: "allow",
    });
    await promise;
  });

  test("approval request metadata is forwarded to prompt data", async () => {
    const promise = bridge.handler(makeRequest({ metadata: { source: "middleware" } }));
    const state = store.getState();
    if (state.modal?.kind === "permission-prompt") {
      expect(state.modal.prompt.metadata).toEqual({ source: "middleware" });
    }

    bridge.respond(state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "", {
      kind: "allow",
    });
    await promise;
  });
});

// ---------------------------------------------------------------------------
// Queue: concurrent prompts
// ---------------------------------------------------------------------------

describe("permission bridge — queue", () => {
  test("second prompt is queued, not shown until first is resolved", async () => {
    const promise1 = bridge.handler(makeRequest({ toolId: "bash" }));
    const promise2 = bridge.handler(makeRequest({ toolId: "read_file" }));

    expect(bridge.pendingCount()).toBe(2);

    // Only the first is shown
    const state1 = store.getState();
    if (state1.modal?.kind === "permission-prompt") {
      expect(state1.modal.prompt.toolId).toBe("bash");
    }

    // Respond to first
    const id1 = state1.modal?.kind === "permission-prompt" ? state1.modal.prompt.requestId : "";
    bridge.respond(id1, { kind: "allow" });

    const d1 = await promise1;
    expect(d1.kind).toBe("allow");

    // Second should now be shown
    // Wait for microtask
    await new Promise<void>((r) => queueMicrotask(r));
    const state2 = store.getState();
    expect(state2.modal?.kind).toBe("permission-prompt");
    if (state2.modal?.kind === "permission-prompt") {
      expect(state2.modal.prompt.toolId).toBe("read_file");
    }

    // Respond to second
    const id2 = state2.modal?.kind === "permission-prompt" ? state2.modal.prompt.requestId : "";
    bridge.respond(id2, { kind: "deny", reason: "nope" });

    const d2 = await promise2;
    expect(d2).toEqual({ kind: "deny", reason: "nope" });
    expect(bridge.pendingCount()).toBe(0);
  });

  test("three queued prompts resolve in order", async () => {
    const results: ApprovalDecision[] = [];

    const p1 = bridge.handler(makeRequest({ toolId: "a" }));
    const p2 = bridge.handler(makeRequest({ toolId: "b" }));
    const p3 = bridge.handler(makeRequest({ toolId: "c" }));

    // Resolve in order
    for (const expectedTool of ["a", "b", "c"]) {
      await new Promise<void>((r) => queueMicrotask(r));
      const state = store.getState();
      if (state.modal?.kind === "permission-prompt") {
        expect(state.modal.prompt.toolId).toBe(expectedTool);
        bridge.respond(state.modal.prompt.requestId, { kind: "allow" });
      }
    }

    results.push(await p1, await p2, await p3);
    expect(results).toEqual([{ kind: "allow" }, { kind: "allow" }, { kind: "allow" }]);
    expect(bridge.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("permission bridge — timeout", () => {
  test("auto-denies after timeout with fail-closed reason", async () => {
    const promise = bridge.handler(makeRequest());
    expect(bridge.pendingCount()).toBe(1);

    // Wait for timeout (100ms in test)
    const decision = await promise;
    expect(decision).toEqual({ kind: "deny", reason: "Permission prompt timed out" });
    expect(bridge.pendingCount()).toBe(0);
  });

  test("timeout advances queue to next prompt", async () => {
    const p1 = bridge.handler(makeRequest({ toolId: "slow-tool" }));
    const p2 = bridge.handler(makeRequest({ toolId: "fast-tool" }));

    // First times out
    const d1 = await p1;
    expect(d1).toEqual({ kind: "deny", reason: "Permission prompt timed out" });

    // Second should now be shown
    await new Promise<void>((r) => queueMicrotask(r));
    const state = store.getState();
    if (state.modal?.kind === "permission-prompt") {
      expect(state.modal.prompt.toolId).toBe("fast-tool");
      bridge.respond(state.modal.prompt.requestId, { kind: "allow" });
    }

    const d2 = await p2;
    expect(d2.kind).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Queue timeout safety: lifetime timer prevents stale prompts
// ---------------------------------------------------------------------------

describe("permission bridge — queued lifetime timer", () => {
  test("queued prompt answered quickly after front resolves succeeds", async () => {
    // Short timeout — respond to first quickly so second still has time
    bridge.dispose();
    bridge = createPermissionBridge({ store, timeoutMs: 200 });

    const p1 = bridge.handler(makeRequest({ toolId: "first" }));
    const p2 = bridge.handler(makeRequest({ toolId: "second" }));

    expect(bridge.pendingCount()).toBe(2);

    // Respond to first immediately
    await new Promise<void>((r) => queueMicrotask(r));
    const state1 = store.getState();
    if (state1.modal?.kind === "permission-prompt") {
      expect(state1.modal.prompt.toolId).toBe("first");
      bridge.respond(state1.modal.prompt.requestId, { kind: "allow" });
    }
    const d1 = await p1;
    expect(d1.kind).toBe("allow");

    // Second is now visible — respond before timeout
    await new Promise<void>((r) => queueMicrotask(r));
    const state2 = store.getState();
    if (state2.modal?.kind === "permission-prompt") {
      expect(state2.modal.prompt.toolId).toBe("second");
      bridge.respond(state2.modal.prompt.requestId, { kind: "allow" });
    }
    const d2 = await p2;
    expect(d2.kind).toBe("allow");
    expect(bridge.pendingCount()).toBe(0);
  });

  test("queued prompt expires via lifetime timer if engine timeout elapses", async () => {
    bridge.dispose();
    bridge = createPermissionBridge({ store, timeoutMs: 50 });

    const p1 = bridge.handler(makeRequest({ toolId: "first" }));
    const p2 = bridge.handler(makeRequest({ toolId: "second" }));

    // Wait for both to expire (lifetime timer fires at 50ms for both)
    const [d1, d2] = await Promise.all([p1, p2]);

    // Both denied — first via UX timer, second via lifetime timer
    expect(d1.kind).toBe("deny");
    expect(d2.kind).toBe("deny");
    expect(bridge.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// tool_execution_started dispatch (#1759)
// ---------------------------------------------------------------------------

describe("permission bridge — tool_execution_started dispatch", () => {
  test("respond with allow dispatches tool_execution_started with the callId from metadata", () => {
    const captured: Array<{ readonly kind: string; readonly callId?: string }> = [];
    const wrapped: TuiStore = {
      ...store,
      dispatch: (action) => {
        captured.push(action as { readonly kind: string; readonly callId?: string });
        store.dispatch(action);
      },
    };
    const local = createPermissionBridge({ store: wrapped, timeoutMs: 100 });
    void local.handler(makeRequest({ toolId: "Bash", callId: "call-xyz" }));
    const state = store.getState();
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";

    local.respond(requestId, { kind: "allow" });

    const dispatched = captured.find((a) => a.kind === "tool_execution_started");
    expect(dispatched).toBeDefined();
    expect(dispatched?.callId).toBe("call-xyz");
    local.dispose();
  });

  test("respond with allow WITHOUT callId in metadata does not dispatch (fallback path)", () => {
    const captured: Array<{ readonly kind: string }> = [];
    const wrapped: TuiStore = {
      ...store,
      dispatch: (action) => {
        captured.push(action as { readonly kind: string });
        store.dispatch(action);
      },
    };
    const local = createPermissionBridge({ store: wrapped, timeoutMs: 100 });
    // No metadata.callId — older caller path
    void local.handler(makeRequest({ toolId: "Bash" }));
    const state = store.getState();
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";

    local.respond(requestId, { kind: "allow" });

    // Without a call-scoped id the bridge cannot safely target a specific
    // running block, so the dispatch is intentionally skipped.
    expect(captured.some((a) => a.kind === "tool_execution_started")).toBe(false);
    local.dispose();
  });

  test("respond with deny does NOT dispatch tool_execution_started", () => {
    const captured: Array<{ readonly kind: string }> = [];
    const wrapped: TuiStore = {
      ...store,
      dispatch: (action) => {
        captured.push(action as { readonly kind: string });
        store.dispatch(action);
      },
    };
    const local = createPermissionBridge({ store: wrapped, timeoutMs: 100 });
    void local.handler(makeRequest({ toolId: "Bash", callId: "call-xyz" }));
    const state = store.getState();
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";

    local.respond(requestId, { kind: "deny", reason: "nope" });

    expect(captured.some((a) => a.kind === "tool_execution_started")).toBe(false);
    local.dispose();
  });

  test("infinite timeout: handler never auto-denies, waits until respond is called", async () => {
    const local = createPermissionBridge({ store, timeoutMs: Number.POSITIVE_INFINITY });
    const promise = local.handler(makeRequest({ toolId: "Bash" }));
    // Yield the event loop a few times — with a finite timer this would fire.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(local.pendingCount()).toBe(1);

    const state = store.getState();
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";
    local.respond(requestId, { kind: "allow" });

    const decision = await promise;
    expect(decision).toEqual({ kind: "allow" });
    expect(local.pendingCount()).toBe(0);
    local.dispose();
  });
});

// ---------------------------------------------------------------------------
// cancelPending — abort/reset cleanup without tearing down the bridge
// (#1759 review round 2)
// ---------------------------------------------------------------------------

describe("permission bridge — cancelPending", () => {
  test("denies all pending and dismisses the modal without disposing", async () => {
    // Long timeout so nothing else cancels in the test window
    const local = createPermissionBridge({ store, timeoutMs: 60_000 });
    const p1 = local.handler(makeRequest({ toolId: "Bash" }));
    const p2 = local.handler(makeRequest({ toolId: "fs_write" }));
    expect(local.pendingCount()).toBe(2);
    expect(store.getState().modal?.kind).toBe("permission-prompt");

    local.cancelPending("Turn cancelled by user");

    // Both pending promises resolve to deny with the cancel reason
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1).toEqual({ kind: "deny", reason: "Turn cancelled by user" });
    expect(d2).toEqual({ kind: "deny", reason: "Turn cancelled by user" });

    // Modal dismissed
    expect(store.getState().modal).toBeNull();
    expect(local.pendingCount()).toBe(0);

    // Bridge is still usable — a new prompt after cancel works
    const p3 = local.handler(makeRequest({ toolId: "Grep" }));
    expect(local.pendingCount()).toBe(1);
    expect(store.getState().modal?.kind).toBe("permission-prompt");
    const newRequestId =
      store.getState().modal?.kind === "permission-prompt"
        ? (store.getState().modal as { prompt: { requestId: string } }).prompt.requestId
        : "";
    local.respond(newRequestId, { kind: "allow" });
    const d3 = await p3;
    expect(d3).toEqual({ kind: "allow" });

    local.dispose();
  });

  test("dispose still works as terminal cleanup (delegates to cancelPending)", async () => {
    const local = createPermissionBridge({ store, timeoutMs: 60_000 });
    const p = local.handler(makeRequest({ toolId: "Bash" }));
    local.dispose();
    const decision = await p;
    expect(decision).toEqual({ kind: "deny", reason: "Permission bridge disposed" });
    expect(store.getState().modal).toBeNull();
  });

  test("cancelPending on empty queue is a no-op", () => {
    const local = createPermissionBridge({ store, timeoutMs: 60_000 });
    expect(() => local.cancelPending("nothing to cancel")).not.toThrow();
    expect(local.pendingCount()).toBe(0);
    local.dispose();
  });

  test("cancelPending CLEARS modal (does NOT restore savedModal) — regression #1759 round 8", async () => {
    // Simulate a session-reset scenario: command palette is open, then a
    // permission prompt arrives, then user triggers session:new. The
    // pre-prompt modal must NOT reappear after cancellation — it belongs
    // to the prior session context.
    const local = createPermissionBridge({ store, timeoutMs: 60_000 });
    store.dispatch({ kind: "set_modal", modal: { kind: "command-palette", query: "do" } });
    expect(store.getState().modal?.kind).toBe("command-palette");

    void local.handler(makeRequest({ toolId: "Bash" }));
    await new Promise<void>((r) => queueMicrotask(r));
    expect(store.getState().modal?.kind).toBe("permission-prompt");

    // Reset/abort path
    local.cancelPending("Session reset");
    await new Promise<void>((r) => queueMicrotask(r));

    // Modal must be cleared. The command palette must NOT be restored.
    expect(store.getState().modal).toBeNull();
    local.dispose();
  });

  test("dispose still restores savedModal (terminal cleanup contract preserved)", async () => {
    // Confirms cancelPending and dispose have distinct modal semantics.
    const local = createPermissionBridge({ store, timeoutMs: 60_000 });
    store.dispatch({ kind: "set_modal", modal: { kind: "command-palette", query: "do" } });

    void local.handler(makeRequest({ toolId: "Bash" }));
    await new Promise<void>((r) => queueMicrotask(r));

    local.dispose();
    await new Promise<void>((r) => queueMicrotask(r));

    // Dispose restores the pre-prompt modal — different from cancelPending.
    expect(store.getState().modal?.kind).toBe("command-palette");
  });
});

// ---------------------------------------------------------------------------
// Negative / edge cases
// ---------------------------------------------------------------------------

describe("permission bridge — edge cases", () => {
  test("respond with stale requestId is a no-op", async () => {
    const promise = bridge.handler(makeRequest());
    expect(bridge.pendingCount()).toBe(1);

    // Respond with wrong ID — should not resolve the promise or change pending count
    bridge.respond("nonexistent-id", { kind: "allow" });
    expect(bridge.pendingCount()).toBe(1);

    // Now respond correctly
    const state = store.getState();
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";
    bridge.respond(requestId, { kind: "allow" });

    const decision = await promise;
    expect(decision.kind).toBe("allow");
  });

  test("double respond to same requestId — second is a no-op", async () => {
    const promise = bridge.handler(makeRequest());
    const state = store.getState();
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";

    bridge.respond(requestId, { kind: "allow" });
    bridge.respond(requestId, { kind: "deny", reason: "too late" }); // should be ignored

    const decision = await promise;
    expect(decision).toEqual({ kind: "allow" }); // first response wins
  });

  test("respond after timeout is a no-op", async () => {
    const promise = bridge.handler(makeRequest());
    const state = store.getState();
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";

    // Wait for timeout
    const decision = await promise;
    expect(decision.kind).toBe("deny"); // timed out

    // Late respond is a no-op
    bridge.respond(requestId, { kind: "allow" });
    expect(bridge.pendingCount()).toBe(0);
  });

  test("dispose denies all pending prompts", async () => {
    const p1 = bridge.handler(makeRequest({ toolId: "a" }));
    const p2 = bridge.handler(makeRequest({ toolId: "b" }));
    expect(bridge.pendingCount()).toBe(2);

    bridge.dispose();

    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1).toEqual({ kind: "deny", reason: "Permission bridge disposed" });
    expect(d2).toEqual({ kind: "deny", reason: "Permission bridge disposed" });
    expect(bridge.pendingCount()).toBe(0);
  });

  test("dispose clears visible permission modal from store", async () => {
    bridge.handler(makeRequest());

    // Modal should be showing
    expect(store.getState().modal?.kind).toBe("permission-prompt");

    bridge.dispose();

    // Wait for microtask to flush store notification
    await new Promise<void>((r) => queueMicrotask(r));

    // Modal must be cleared — no stale prompt left behind
    expect(store.getState().modal).toBeNull();
  });

  test("permission prompt arriving during command-palette preserves and restores it", async () => {
    // Open command palette
    store.dispatch({ kind: "set_modal", modal: { kind: "command-palette", query: "hel" } });
    expect(store.getState().modal?.kind).toBe("command-palette");

    // Permission prompt arrives — should take over the modal
    const promise = bridge.handler(makeRequest());
    await new Promise<void>((r) => queueMicrotask(r));
    expect(store.getState().modal?.kind).toBe("permission-prompt");

    // Respond to the prompt
    const state = store.getState();
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";
    bridge.respond(requestId, { kind: "allow" });
    await promise;

    // Wait for microtask
    await new Promise<void>((r) => queueMicrotask(r));

    // Command palette should be restored
    const restored = store.getState().modal;
    expect(restored?.kind).toBe("command-palette");
    if (restored?.kind === "command-palette") {
      expect(restored.query).toBe("hel");
    }
  });

  test("dispose restores previous modal instead of setting null", async () => {
    // Open command palette
    store.dispatch({ kind: "set_modal", modal: { kind: "command-palette", query: "x" } });

    bridge.handler(makeRequest());
    await new Promise<void>((r) => queueMicrotask(r));
    expect(store.getState().modal?.kind).toBe("permission-prompt");

    bridge.dispose();
    await new Promise<void>((r) => queueMicrotask(r));

    // Should restore command palette, not null
    expect(store.getState().modal?.kind).toBe("command-palette");
  });

  test("handler called after dispose still works (creates new pending)", async () => {
    bridge.dispose();

    // Re-create after dispose
    bridge = createPermissionBridge({ store, timeoutMs: 100 });
    const promise = bridge.handler(makeRequest());
    expect(bridge.pendingCount()).toBe(1);

    const state = store.getState();
    const requestId = state.modal?.kind === "permission-prompt" ? state.modal.prompt.requestId : "";
    bridge.respond(requestId, { kind: "allow" });

    const decision = await promise;
    expect(decision.kind).toBe("allow");
  });
});
