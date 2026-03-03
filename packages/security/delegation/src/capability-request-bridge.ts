/**
 * Capability Request Bridge — handles incoming pull-model delegation requests.
 *
 * Returns a ComponentProvider (priority 101) and a KoiMiddleware (priority 125),
 * connected by shared closure state. The provider registers a Tier 1 handler
 * (instant auto-grant) via mailbox.onMessage; the middleware processes Tier 2
 * (HITL approval / bubble-up) in onBeforeTurn.
 *
 * Flow:
 *   Agent A → delegation_request tool → Mailbox message (kind: "request")
 *   Agent B receives via onMessage:
 *     Tier 1: canAutoGrant? → manager.grant() → respond granted
 *     else → queue for Tier 2
 *   Tier 2 (onBeforeTurn):
 *     requestApproval? → HITL (with timeout) → grant/deny → respond
 *     no requestApproval? → bubble-up to parent (or deny at root)
 */

import type {
  Agent,
  AgentId,
  AgentMessage,
  ApprovalDecision,
  ComponentProvider,
  DelegationScope,
  JsonObject,
  KoiMiddleware,
  MailboxComponent,
  PermissionConfig,
  TrustTier,
  TurnContext,
} from "@koi/core";
import { DELEGATION, MAILBOX, messageId, agentId as toAgentId } from "@koi/core";
import {
  CAPABILITY_REQUEST_TYPE,
  CAPABILITY_RESPONSE_STATUS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_FORWARD_DEPTH,
} from "./capability-request-constants.js";
import type { DelegationManager } from "./delegation-manager.js";
import { DEFAULT_PREFIX } from "./tools/constants.js";
import { createDelegationRequestTool } from "./tools/request.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapabilityRequestBridgeConfig {
  readonly manager: DelegationManager;
  /** Tier 1 policy: if provided and returns true, auto-grants without HITL. */
  readonly canAutoGrant?: (agentScope: DelegationScope, requestedScope: DelegationScope) => boolean;
  /** Timeout (ms) for HITL approval on the receiver side. Default: 60_000. */
  readonly approvalTimeoutMs?: number | undefined;
  /** Maximum forward depth for bubble-up routing. Default: 5. */
  readonly maxForwardDepth?: number | undefined;
  /** Tool name prefix. Default: "delegation". */
  readonly prefix?: string | undefined;
  /** Trust tier for the request tool. Default: "verified". */
  readonly trustTier?: TrustTier | undefined;
}

export interface CapabilityRequestBridge {
  readonly provider: ComponentProvider;
  readonly middleware: KoiMiddleware;
}

/** Internal queue entry for Tier 2 processing. */
interface PendingRequest {
  readonly message: AgentMessage;
  readonly requestedScope: DelegationScope;
  readonly reason: string;
  readonly requesterId: AgentId;
  readonly originalCorrelationId: string;
  readonly forwardDepth: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapPayloadToScope(payload: JsonObject): DelegationScope {
  const perms = payload.permissions;
  if (perms === null || perms === undefined || typeof perms !== "object") {
    return { permissions: {} };
  }
  const p = perms as Record<string, unknown>;
  const allow = Array.isArray(p.allow) ? (p.allow as readonly string[]) : undefined;
  const deny = Array.isArray(p.deny) ? (p.deny as readonly string[]) : undefined;
  const permissions: PermissionConfig = {
    ...(allow !== undefined ? { allow } : {}),
    ...(deny !== undefined ? { deny } : {}),
  };

  const resources = Array.isArray(payload.resources)
    ? (payload.resources as readonly string[])
    : undefined;
  return {
    permissions,
    ...(resources !== undefined ? { resources } : {}),
  };
}

function mapScopeToPayload(scope: DelegationScope): JsonObject {
  return {
    permissions: {
      ...(scope.permissions.allow !== undefined ? { allow: scope.permissions.allow } : {}),
      ...(scope.permissions.deny !== undefined ? { deny: scope.permissions.deny } : {}),
    },
    ...(scope.resources !== undefined ? { resources: scope.resources } : {}),
  } satisfies JsonObject;
}

function extractRequesterId(message: AgentMessage): AgentId {
  const forwarded = message.payload.requesterId;
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return toAgentId(forwarded);
  }
  return message.from;
}

function extractOriginalCorrelationId(message: AgentMessage): string {
  const original = message.payload._originalCorrelationId;
  if (typeof original === "string" && original.length > 0) {
    return original;
  }
  return message.id;
}

function extractForwardDepth(payload: JsonObject): number {
  const depth = payload._forwardDepth;
  return typeof depth === "number" ? depth : 0;
}

async function sendGrantedResponse(
  mailbox: MailboxComponent,
  fromId: AgentId,
  toId: AgentId,
  correlationId: string,
  grantId: string,
  scope: DelegationScope,
): Promise<void> {
  const result = await mailbox.send({
    from: fromId,
    to: toId,
    kind: "response",
    correlationId: messageId(correlationId),
    type: CAPABILITY_REQUEST_TYPE,
    payload: {
      status: CAPABILITY_RESPONSE_STATUS.GRANTED,
      grantId,
      scope: mapScopeToPayload(scope),
    },
  });
  if (!result.ok) {
    throw new Error(`Failed to deliver grant response to ${toId}: ${result.error.message}`, {
      cause: result.error,
    });
  }
}

async function sendDeniedResponse(
  mailbox: MailboxComponent,
  fromId: AgentId,
  toId: AgentId,
  correlationId: string,
  reason: string,
): Promise<void> {
  const result = await mailbox.send({
    from: fromId,
    to: toId,
    kind: "response",
    correlationId: messageId(correlationId),
    type: CAPABILITY_REQUEST_TYPE,
    payload: {
      status: CAPABILITY_RESPONSE_STATUS.DENIED,
      reason,
    },
  });
  if (!result.ok) {
    throw new Error(`Failed to deliver denial response to ${toId}: ${result.error.message}`, {
      cause: result.error,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCapabilityRequestBridge(
  config: CapabilityRequestBridgeConfig,
): CapabilityRequestBridge {
  const {
    manager,
    canAutoGrant,
    approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    maxForwardDepth = MAX_FORWARD_DEPTH,
    prefix = DEFAULT_PREFIX,
    trustTier = "verified",
  } = config;

  // Shared closure state (provider ↔ middleware) — cleaned up on detach
  const pendingRequests = new Map<string, PendingRequest[]>();
  const agentMailboxes = new Map<string, MailboxComponent>();
  const agentParentIds = new Map<string, AgentId | undefined>();

  // -------------------------------------------------------------------------
  // Provider (priority 101)
  // -------------------------------------------------------------------------

  const provider: ComponentProvider = {
    name: "capability-request-bridge",
    priority: 101,

    attach: async (agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const mailbox = agent.component(MAILBOX);
      const delegation = agent.component(DELEGATION);

      // Skip if required components are missing
      if (mailbox === undefined || delegation === undefined) {
        return new Map();
      }

      const ownerAgentId = agent.pid.id;
      const components = new Map<string, unknown>();

      // Store references for middleware
      agentMailboxes.set(ownerAgentId, mailbox);
      agentParentIds.set(ownerAgentId, agent.pid.parent);

      // Register Tier 1 handler with error boundary
      mailbox.onMessage(async (message: AgentMessage) => {
        if (message.type !== CAPABILITY_REQUEST_TYPE) return;
        if (message.kind !== "request") return;

        try {
          await handleTier1Request(mailbox, delegation, ownerAgentId, message);
        } catch (e: unknown) {
          // Best-effort: send denial so the requester isn't left hanging
          const errMsg =
            e instanceof Error ? e.message : "Internal error processing capability request";
          await sendDeniedResponse(
            mailbox,
            ownerAgentId,
            extractRequesterId(message),
            extractOriginalCorrelationId(message),
            errMsg,
          ).catch(() => {
            // Delivery failure on the error path — nothing more we can do
          });
        }
      });

      // Attach delegation_request tool
      const requestTool = createDelegationRequestTool(mailbox, ownerAgentId, prefix, trustTier);
      components.set(`tool:${requestTool.descriptor.name}`, requestTool);

      return components;
    },

    detach: async (agent: Agent): Promise<void> => {
      const id = agent.pid.id;
      pendingRequests.delete(id);
      agentMailboxes.delete(id);
      agentParentIds.delete(id);
    },
  };

  async function handleTier1Request(
    mailbox: MailboxComponent,
    delegation: { readonly list: () => Promise<readonly { readonly scope: DelegationScope }[]> },
    ownerAgentId: AgentId,
    message: AgentMessage,
  ): Promise<void> {
    const requestedScope = mapPayloadToScope(message.payload);
    const requesterId = extractRequesterId(message);
    const originalCorrelationId = extractOriginalCorrelationId(message);
    const forwardDepth = extractForwardDepth(message.payload);
    const reason =
      typeof message.payload.reason === "string" ? message.payload.reason : "No reason provided";

    // Tier 1: check auto-grant policy
    if (canAutoGrant !== undefined) {
      const grants = await delegation.list();
      const agentScope: DelegationScope = {
        permissions: { allow: grants.flatMap((g) => g.scope.permissions.allow ?? []) },
      };

      if (canAutoGrant(agentScope, requestedScope)) {
        const grantResult = await manager.grant(ownerAgentId, requesterId, requestedScope);

        if (grantResult.ok) {
          await sendGrantedResponse(
            mailbox,
            ownerAgentId,
            requesterId,
            originalCorrelationId,
            grantResult.value.id,
            grantResult.value.scope,
          );
          return;
        }
      }
    }

    // Queue for Tier 2 processing
    const queue = pendingRequests.get(ownerAgentId) ?? [];
    pendingRequests.set(ownerAgentId, [
      ...queue,
      { message, requestedScope, reason, requesterId, originalCorrelationId, forwardDepth },
    ]);
  }

  // -------------------------------------------------------------------------
  // Middleware (priority 125)
  // -------------------------------------------------------------------------

  const middleware: KoiMiddleware = {
    name: "koi:capability-request",
    priority: 125,

    onBeforeTurn: async (ctx: TurnContext): Promise<void> => {
      const currentAgentId = toAgentId(ctx.session.agentId);
      const queue = pendingRequests.get(currentAgentId);
      if (queue === undefined || queue.length === 0) return;

      // Drain queue (snapshot + clear)
      const snapshot = [...queue];
      pendingRequests.set(currentAgentId, []);

      const mailbox = agentMailboxes.get(currentAgentId);
      if (mailbox === undefined) return;

      for (const pending of snapshot) {
        await processPendingRequest(ctx, currentAgentId, mailbox, pending);
      }
    },

    describeCapabilities: () => ({
      label: "cap-requests",
      description: "Handles incoming capability requests via HITL or bubble-up",
    }),
  };

  async function handleHitlDecision(
    ctx: TurnContext,
    currentAgentId: AgentId,
    mailbox: MailboxComponent,
    pending: PendingRequest,
  ): Promise<void> {
    if (ctx.requestApproval === undefined) return;

    const approvalPromise = ctx.requestApproval({
      toolId: CAPABILITY_REQUEST_TYPE,
      input: pending.message.payload,
      reason: pending.reason,
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`HITL approval timed out after ${approvalTimeoutMs}ms`)),
        approvalTimeoutMs,
      );
    });

    // let: required — reassigned from two branches of try/catch
    let decision: ApprovalDecision;
    try {
      decision = await Promise.race([approvalPromise, timeoutPromise]);
    } catch (e: unknown) {
      // Timeout or requestApproval error → deny
      const msg = e instanceof Error ? e.message : "Approval failed";
      await sendDeniedResponse(
        mailbox,
        currentAgentId,
        pending.requesterId,
        pending.originalCorrelationId,
        msg,
      );
      return;
    }

    if (decision.kind === "allow") {
      await grantAndRespond(currentAgentId, mailbox, pending, pending.requestedScope);
      return;
    }

    if (decision.kind === "modify") {
      const narrowedScope = mapPayloadToScope(decision.updatedInput);
      await grantAndRespond(currentAgentId, mailbox, pending, narrowedScope);
      return;
    }

    // decision.kind === "deny"
    await sendDeniedResponse(
      mailbox,
      currentAgentId,
      pending.requesterId,
      pending.originalCorrelationId,
      decision.reason,
    );
  }

  async function grantAndRespond(
    currentAgentId: AgentId,
    mailbox: MailboxComponent,
    pending: PendingRequest,
    scope: DelegationScope,
  ): Promise<void> {
    const grantResult = await manager.grant(currentAgentId, pending.requesterId, scope);
    if (grantResult.ok) {
      await sendGrantedResponse(
        mailbox,
        currentAgentId,
        pending.requesterId,
        pending.originalCorrelationId,
        grantResult.value.id,
        grantResult.value.scope,
      );
    } else {
      await sendDeniedResponse(
        mailbox,
        currentAgentId,
        pending.requesterId,
        pending.originalCorrelationId,
        grantResult.error.message,
      );
    }
  }

  async function processPendingRequest(
    ctx: TurnContext,
    currentAgentId: AgentId,
    mailbox: MailboxComponent,
    pending: PendingRequest,
  ): Promise<void> {
    // Tier 2a: HITL approval
    if (ctx.requestApproval !== undefined) {
      await handleHitlDecision(ctx, currentAgentId, mailbox, pending);
      return;
    }

    // Tier 2b: Bubble-up to parent
    const parentId = agentParentIds.get(currentAgentId);
    if (parentId === undefined) {
      await sendDeniedResponse(
        mailbox,
        currentAgentId,
        pending.requesterId,
        pending.originalCorrelationId,
        "No approval handler available and no parent to forward to",
      );
      return;
    }

    if (pending.forwardDepth >= maxForwardDepth) {
      await sendDeniedResponse(
        mailbox,
        currentAgentId,
        pending.requesterId,
        pending.originalCorrelationId,
        `Maximum forward depth (${maxForwardDepth}) exceeded`,
      );
      return;
    }

    // Forward to parent, preserving original requester
    const forwardResult = await mailbox.send({
      from: currentAgentId,
      to: parentId,
      kind: "request",
      type: CAPABILITY_REQUEST_TYPE,
      payload: {
        ...pending.message.payload,
        requesterId: pending.requesterId,
        _originalCorrelationId: pending.originalCorrelationId,
        _forwardDepth: pending.forwardDepth + 1,
      },
    });

    // If forwarding fails, deny immediately so requester isn't left hanging
    if (!forwardResult.ok) {
      await sendDeniedResponse(
        mailbox,
        currentAgentId,
        pending.requesterId,
        pending.originalCorrelationId,
        `Failed to forward request to parent: ${forwardResult.error.message}`,
      );
    }
  }

  return { provider, middleware };
}
