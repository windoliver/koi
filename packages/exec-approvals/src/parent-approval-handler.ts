/**
 * Parent-side approval handler factory.
 *
 * Listens for exec-approval IPC requests from child agents, evaluates them
 * against the parent's own rules using evaluateToolRequest(), and responds
 * with a ProgressiveDecision-compatible IPC response.
 *
 * Flow: child request → validate payload → evaluate rules → respond
 * If rules say "ask" and onAsk is configured → delegate to parent's HITL.
 * If rules say "ask" and no onAsk → respond with "ask" (escalation signal).
 */

import type { AgentId, AgentMessage, JsonObject, MailboxComponent } from "@koi/core";
import type { MessageId } from "@koi/core/mailbox";
import type { RiskAnalysis } from "@koi/core/security-analyzer";

import { evaluateToolRequest } from "./evaluate.js";
import type { ExecApprovalIpcResponse } from "./ipc-types.js";
import { EXEC_APPROVAL_REQUEST_TYPE, validateExecApprovalIpcPayload } from "./ipc-types.js";
import { defaultExtractCommand } from "./pattern.js";
import type { ExecApprovalRequest, ProgressiveDecision } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ParentApprovalHandlerConfig {
  readonly agentId: AgentId;
  readonly mailbox: MailboxComponent;
  readonly rules: {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
    readonly ask: readonly string[];
  };
  readonly extractCommand?: ((input: JsonObject) => string) | undefined;
  readonly onAsk?: ((req: ExecApprovalRequest) => Promise<ProgressiveDecision>) | undefined;
  readonly sessionState?:
    | { readonly extraAllow: readonly string[]; readonly extraDeny: readonly string[] }
    | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a parent-side approval handler that listens for child requests.
 *
 * Returns a Disposable — call `[Symbol.dispose]()` to unsubscribe.
 */
export function createParentApprovalHandler(config: ParentApprovalHandlerConfig): Disposable {
  const {
    agentId,
    mailbox,
    rules,
    extractCommand = defaultExtractCommand,
    onAsk,
    sessionState,
  } = config;

  const unsub = mailbox.onMessage((message: AgentMessage) => {
    // O(1) type check before validation
    if (message.type !== EXEC_APPROVAL_REQUEST_TYPE) return;
    if (message.kind !== "request") return;

    // Check TTL — skip expired messages
    if (isExpired(message)) return;

    // Fire-and-forget async handler (errors logged, never thrown)
    void handleMessage(message).catch((e: unknown) => {
      console.error("[koi:approval-routing] handleMessage failed", {
        messageId: message.id,
        from: message.from,
        error: e instanceof Error ? e.message : String(e),
      });
      void respondWithDeny(message, "Internal error processing approval request");
    });
  });

  async function handleMessage(message: AgentMessage): Promise<void> {
    // Validate IPC payload
    const validated = validateExecApprovalIpcPayload(message.payload);
    if (!validated.ok) {
      await respondWithDeny(message, `Invalid payload: ${validated.error.message}`);
      return;
    }

    const payload = validated.value;

    // Evaluate against parent's rules
    const evaluation = evaluateToolRequest(payload.toolId, payload.input as JsonObject, {
      baseDeny: rules.deny,
      sessionDeny: sessionState?.extraDeny ?? [],
      sessionAllow: sessionState?.extraAllow ?? [],
      baseAllow: rules.allow,
      baseAsk: rules.ask,
      extractCommand,
    });

    switch (evaluation.kind) {
      case "allow": {
        await respond(message, { decision: { kind: "allow_once" } });
        return;
      }

      case "deny": {
        await respond(message, {
          decision: { kind: "deny_once", reason: evaluation.reason },
        });
        return;
      }

      case "ask": {
        if (onAsk !== undefined) {
          // Delegate to parent's own HITL
          const riskAnalysis: RiskAnalysis | undefined =
            payload.riskAnalysis !== undefined
              ? {
                  riskLevel: payload.riskAnalysis.riskLevel,
                  findings: [],
                  rationale: payload.riskAnalysis.rationale,
                }
              : undefined;
          const askReq: ExecApprovalRequest = {
            toolId: payload.toolId,
            input: payload.input as JsonObject,
            matchedPattern: evaluation.matchedPattern,
            ...(riskAnalysis !== undefined ? { riskAnalysis } : {}),
          };
          const decision = await onAsk(askReq);
          await respond(message, { decision: mapProgressiveDecision(decision) });
        } else {
          // No onAsk → escalation signal
          await respond(message, { decision: { kind: "ask" } });
        }
        return;
      }
    }
  }

  async function respond(
    originalMessage: AgentMessage,
    payload: ExecApprovalIpcResponse,
  ): Promise<void> {
    await mailbox.send({
      from: agentId,
      to: originalMessage.from,
      kind: "response",
      correlationId: originalMessage.id as MessageId,
      type: EXEC_APPROVAL_REQUEST_TYPE,
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  async function respondWithDeny(message: AgentMessage, reason: string): Promise<void> {
    await respond(message, { decision: { kind: "deny_once", reason } });
  }

  return {
    [Symbol.dispose](): void {
      unsub();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExpired(message: AgentMessage): boolean {
  if (message.ttlSeconds === undefined) return false;
  const createdAt = new Date(message.createdAt).getTime();
  if (Number.isNaN(createdAt)) return true; // fail-closed: unparseable date → treat as expired
  const expiresAt = createdAt + message.ttlSeconds * 1000;
  return Date.now() > expiresAt;
}

function mapProgressiveDecision(
  decision: ProgressiveDecision,
): ExecApprovalIpcResponse["decision"] {
  switch (decision.kind) {
    case "allow_once":
      return { kind: "allow_once" };
    case "allow_session":
      return { kind: "allow_session", pattern: decision.pattern };
    case "allow_always":
      return { kind: "allow_always", pattern: decision.pattern };
    case "deny_once":
      return { kind: "deny_once", reason: decision.reason };
    case "deny_always":
      return { kind: "deny_always", pattern: decision.pattern, reason: decision.reason };
  }
}
