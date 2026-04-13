/**
 * Permission bridge — connects the engine's ApprovalHandler promise to the
 * TUI's reducer-based permission prompt UI.
 *
 * Architecture (Decision 1A from plan review):
 * - Engine middleware awaits a Promise<ApprovalDecision> per tool call
 * - Bridge stores the resolve function in a Map keyed by requestId
 * - TUI component calls bridge.respond(requestId, decision)
 * - Bridge resolves the Promise, dispatches permission_response to store, shows next queue item
 * - Bridge owns the queue — reducer just renders whatever modal it's told
 *
 * Timeout: default is `Number.POSITIVE_INFINITY` — permission prompts wait
 * indefinitely for the user to respond. Callers can still pass a finite
 * `timeoutMs` in tests or in agent-to-agent scenarios where a hung approval
 * handler must be recovered from. The engine-side middleware also defaults
 * to no approval timeout (see @koi/middleware-permissions config). (#1759)
 *
 * When a user approves (allow / always-allow / modify), the bridge dispatches
 * `tool_execution_started` so the TUI reducer can reset startedAt on the
 * matching running tool block — this prevents the elapsed-time counter from
 * including the user's read/decide time.
 */

import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@koi/core/middleware";
import type { TuiStore } from "../state/store.js";
import type { PermissionPromptData, PermissionRiskLevel, TuiModal } from "../state/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default timeout for permission prompts (ms). `Number.POSITIVE_INFINITY`
 * disables the fail-closed deny — the user may take as long as they need
 * to respond. Aligned with @koi/middleware-permissions
 * DEFAULT_APPROVAL_TIMEOUT_MS so the TUI prompt and the engine-side approval
 * window share the same policy.
 *
 * Callers (tests, agent-to-agent runtimes) may pass a finite `timeoutMs`
 * to restore a fail-closed deadline.
 */
export const DEFAULT_PERMISSION_TIMEOUT_MS: number = Number.POSITIVE_INFINITY;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pending approval entry — one per in-flight permission prompt. */
interface PendingApproval {
  readonly requestId: string;
  /**
   * Tool id from the ApprovalRequest — used to dispatch
   * `tool_execution_started` to the reducer so the matching running tool
   * block can reset its startedAt on user approval (#1759).
   */
  readonly toolId: string;
  readonly resolve: (decision: ApprovalDecision) => void;
  /**
   * UX timer — starts when prompt becomes visible (front of queue).
   * `null` if timeouts are disabled (timeoutMs === Infinity).
   */
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Backstop timer — starts at enqueue, ensures prompt can't outlive engine timeout.
   * Prevents stale prompts from being shown after the engine already timed out.
   * `null` if timeouts are disabled (timeoutMs === Infinity).
   */
  readonly lifetimeTimer: ReturnType<typeof setTimeout> | null;
}

/** Options for creating a permission bridge. */
export interface PermissionBridgeOptions {
  /** TUI store to dispatch set_modal and permission_response actions. */
  readonly store: TuiStore;
  /** Timeout in ms before auto-denying. Default: 30_000. */
  readonly timeoutMs?: number;
  /** Risk level classifier. Default: always "medium". */
  readonly classifyRisk?: (request: ApprovalRequest) => PermissionRiskLevel;
  /** Whether persistent "always" approval is available (store configured + user authenticated). */
  readonly permanentAvailable?: boolean;
}

/** The bridge instance returned by createPermissionBridge. */
export interface PermissionBridge {
  /** ApprovalHandler to wire into TurnContext.requestApproval. */
  readonly handler: ApprovalHandler;
  /** Respond to a permission prompt. Called by TUI components (y/n/a keys). */
  readonly respond: (requestId: string, decision: ApprovalDecision) => void;
  /** Cleanup: deny all pending, clear timers. */
  readonly dispose: () => void;
  /** Number of pending (unresolved) approval requests. */
  readonly pendingCount: () => number;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let nextId = 0;

function generateRequestId(): string {
  return `perm-${++nextId}-${Date.now()}`;
}

/** Reset ID counter — test-only. */
export function resetRequestIdCounter(): void {
  nextId = 0;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPermissionBridge(options: PermissionBridgeOptions): PermissionBridge {
  const {
    store,
    timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS,
    classifyRisk,
    permanentAvailable = false,
  } = options;

  // Pending approvals keyed by requestId
  const pending = new Map<string, PendingApproval>();

  // Queue of prompt data waiting to be shown (front = currently displayed)
  const queue: PermissionPromptData[] = [];

  // Modal that was active before the bridge took over — restored when queue empties
  let savedModal: TuiModal | null = null;

  // Start the timeout for a pending entry (called when it becomes visible).
  // No-op when `timeoutMs` is Infinity — the user is given unbounded time
  // to respond (see #1759).
  function startTimer(entry: PendingApproval): void {
    if (!Number.isFinite(timeoutMs)) return;
    if (entry.timer !== null) return; // already started
    entry.timer = setTimeout(() => {
      if (!pending.has(entry.requestId)) return; // already resolved
      pending.delete(entry.requestId);
      removeAndAdvance(entry.requestId);
      entry.resolve({ kind: "deny", reason: "Permission prompt timed out" });
    }, timeoutMs);
  }

  // Show the front of the queue as a modal (or restore previous modal if empty).
  // Starts the timeout for the newly-visible prompt.
  function showFrontOrDismiss(): void {
    const front = queue[0];
    if (front !== undefined) {
      store.dispatch({ kind: "set_modal", modal: { kind: "permission-prompt", prompt: front } });
      // Start timeout now that this prompt is visible to the user
      const entry = pending.get(front.requestId);
      if (entry !== undefined) {
        startTimer(entry);
      }
    } else {
      // Queue empty — restore whatever modal was active before the bridge took over
      store.dispatch({ kind: "set_modal", modal: savedModal });
      savedModal = null;
    }
  }

  // Remove a request from the queue and pending map, show next
  function removeAndAdvance(requestId: string): void {
    const idx = queue.findIndex((p) => p.requestId === requestId);
    if (idx >= 0) {
      queue.splice(idx, 1);
      showFrontOrDismiss();
    }
  }

  function handleApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const requestId = generateRequestId();

      // Default to "high" when no classifier is provided — fail-closed so dangerous
      // requests are visually prominent even if the caller forgets to wire classifyRisk.
      const riskLevel = classifyRisk !== undefined ? classifyRisk(request) : "high";

      const promptData: PermissionPromptData = {
        requestId,
        toolId: request.toolId,
        input: request.input,
        reason: request.reason,
        riskLevel,
        metadata: request.metadata,
        permanentAvailable,
      };

      // Backstop lifetime timer — starts NOW at enqueue time, matching the engine's
      // approval timeout window. Ensures a queued prompt that never becomes visible
      // is cleaned up before the engine times out, preventing stale prompts.
      //
      // No-op when `timeoutMs` is Infinity: users get unbounded time to
      // respond, so there is nothing to back-stop. (#1759)
      const lifetimeTimer: ReturnType<typeof setTimeout> | null = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            if (!pending.has(requestId)) return; // already resolved
            pending.delete(requestId);
            removeAndAdvance(requestId);
            resolve({ kind: "deny", reason: "Permission prompt timed out" });
          }, timeoutMs)
        : null;

      // UX timer starts null — only activated when the prompt reaches the front of the queue
      const entry: PendingApproval = {
        requestId,
        toolId: request.toolId,
        resolve,
        timer: null,
        lifetimeTimer,
      };
      pending.set(requestId, entry);

      // Save the current modal before the bridge takes over (first prompt only)
      if (queue.length === 0) {
        const currentModal = store.getState().modal;
        // Deep-copy the modal to detach from SolidJS store proxy. reconcile()
        // replaces proxy references on update; holding a stale proxy would
        // restore garbage. JSON round-trip is safe — modals are plain data.
        savedModal =
          currentModal?.kind === "permission-prompt"
            ? null
            : currentModal !== null
              ? (JSON.parse(JSON.stringify(currentModal)) as TuiModal)
              : null;
      }

      queue.push(promptData);

      // If this is the only item, show it immediately (which starts the UX timer)
      if (queue.length === 1) {
        showFrontOrDismiss();
      }
      // Otherwise: queued behind another prompt. UX timer starts when it becomes visible.
      // Lifetime timer is already running as a backstop.
    });
  }

  function respond(requestId: string, decision: ApprovalDecision): void {
    const entry = pending.get(requestId);
    if (entry === undefined) return; // stale or already resolved — no-op

    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }
    if (entry.lifetimeTimer !== null) {
      clearTimeout(entry.lifetimeTimer);
    }
    pending.delete(requestId);
    removeAndAdvance(requestId);

    // Dispatch to store so reducer dismisses modal
    store.dispatch({ kind: "permission_response", requestId, decision });

    // If the user approved, notify the reducer so the matching running tool
    // block resets its startedAt — the elapsed-time counter will then reflect
    // actual tool execution time, not the user's read/decide time. (#1759)
    if (
      decision.kind === "allow" ||
      decision.kind === "always-allow" ||
      decision.kind === "modify"
    ) {
      store.dispatch({ kind: "tool_execution_started", toolId: entry.toolId });
    }

    // Resolve the engine's awaited Promise
    entry.resolve(decision);
  }

  function dispose(): void {
    // Deny all pending with cleanup reason
    for (const entry of pending.values()) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
      if (entry.lifetimeTimer !== null) {
        clearTimeout(entry.lifetimeTimer);
      }
      entry.resolve({ kind: "deny", reason: "Permission bridge disposed" });
    }
    pending.clear();
    queue.length = 0;

    // Restore the modal that was active before the bridge took over (or null)
    store.dispatch({ kind: "set_modal", modal: savedModal });
    savedModal = null;
  }

  return {
    handler: handleApproval,
    respond,
    dispose,
    pendingCount: () => pending.size,
  };
}
