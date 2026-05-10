import type {
  EscalationDecision,
  EscalationRequest,
  KoiError,
  PermissionEscalation,
  Result,
} from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import {
  type NexusPermissionEscalationConfig,
  validateNexusPermissionEscalationConfig,
} from "./config.js";
import {
  computeEscalationRequestFingerprint,
  PERMISSION_ESCALATION_DECISION_TYPE,
  PERMISSION_ESCALATION_REQUEST_TYPE,
  type PermissionEscalationDecisionRecord,
  type PermissionEscalationRequestRecord,
} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 250;

interface NexusEnvelope {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "request" | "response" | "event" | "cancel";
  readonly correlationId?: string | undefined;
  readonly createdAt: string;
  readonly ttlSeconds?: number | undefined;
  readonly type: string;
  readonly payload: unknown;
  readonly metadata?: Record<string, unknown> | undefined;
}

interface NexusInboxResponse {
  readonly messages: readonly NexusEnvelope[];
}

interface NexusMailboxClient {
  readonly send: (
    message: Omit<NexusEnvelope, "id" | "createdAt" | "payload"> & {
      readonly payload: Record<string, unknown>;
    },
  ) => Promise<Result<NexusEnvelope, KoiError>>;
  readonly list: (
    agentId: string,
    limit: number,
  ) => Promise<Result<readonly NexusEnvelope[], KoiError>>;
}

function malformedInboxDecision(): EscalationDecision {
  return {
    decision: "rejected",
    reason: "permission escalation inbox response was malformed",
  };
}

function timeoutDecision(): EscalationDecision {
  return { decision: "expired", reason: "permission escalation timed out" };
}

function rejectDecision(reason: string): EscalationDecision {
  return { decision: "rejected", reason };
}

function isDecisionRecord(value: unknown): value is PermissionEscalationDecisionRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<PermissionEscalationDecisionRecord>;
  return (
    typeof candidate.requestId === "string" &&
    typeof candidate.workerAgentId === "string" &&
    typeof candidate.coordinatorAgentId === "string" &&
    typeof candidate.resolvedAt === "number" &&
    typeof candidate.requestFingerprint === "string" &&
    typeof candidate.decision === "object" &&
    candidate.decision !== null &&
    typeof candidate.decision.decision === "string"
  );
}

function isInboxResponse(value: unknown): value is NexusInboxResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

function matchesDecisionEnvelope(
  message: NexusEnvelope,
  req: EscalationRequest,
  coordinatorAgentId: string,
): message is NexusEnvelope & { readonly payload: PermissionEscalationDecisionRecord } {
  return (
    message.kind === "response" &&
    message.type === PERMISSION_ESCALATION_DECISION_TYPE &&
    message.from === coordinatorAgentId &&
    message.to === req.agentId &&
    isDecisionRecord(message.payload) &&
    message.payload.requestId === req.requestId &&
    message.payload.workerAgentId === req.agentId &&
    message.payload.coordinatorAgentId === coordinatorAgentId &&
    message.payload.requestFingerprint === computeEscalationRequestFingerprint(req)
  );
}

function createNexusMailboxClient(transport: NexusTransport, prefix: string): NexusMailboxClient {
  return {
    send: async (message) =>
      transport.call<NexusEnvelope>(`${prefix}.send`, {
        from: message.from,
        to: message.to,
        kind: message.kind,
        correlationId: message.correlationId,
        ttlSeconds: message.ttlSeconds,
        type: message.type,
        payload: message.payload,
        metadata: message.metadata,
      }),
    list: async (agentId, limit) => {
      const result = await transport.call<NexusInboxResponse>(`${prefix}.list`, { agentId, limit });
      if (!result.ok) {
        return result;
      }
      if (!isInboxResponse(result.value)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "permission escalation inbox response was malformed",
            retryable: false,
          },
        };
      }
      return { ok: true, value: result.value.messages };
    },
  };
}

async function findExistingDecision(
  mailbox: NexusMailboxClient,
  req: EscalationRequest,
  coordinatorAgentId: string,
): Promise<
  | { kind: "found"; decision: EscalationDecision }
  | { kind: "miss" }
  | { kind: "error"; decision: EscalationDecision }
> {
  const inbox = await mailbox.list(String(req.agentId), 50);
  if (!inbox.ok) {
    return {
      kind: "error",
      decision:
        inbox.error.code === "VALIDATION"
          ? malformedInboxDecision()
          : rejectDecision(inbox.error.message),
    };
  }
  const match = inbox.value.find((m) => matchesDecisionEnvelope(m, req, coordinatorAgentId));
  return match !== undefined
    ? { kind: "found", decision: match.payload.decision }
    : { kind: "miss" };
}

async function sendEscalationRequest(
  mailbox: NexusMailboxClient,
  req: EscalationRequest,
  coordinatorAgentId: string,
  clock: () => number,
): Promise<EscalationDecision | undefined> {
  const sendResult = await mailbox.send({
    from: req.agentId,
    to: coordinatorAgentId,
    kind: "request",
    correlationId: req.requestId as never,
    ttlSeconds: Math.max(1, Math.ceil((req.expiresAt - clock()) / 1_000)),
    type: PERMISSION_ESCALATION_REQUEST_TYPE,
    payload: {
      kind: PERMISSION_ESCALATION_REQUEST_TYPE,
      request: req,
      workerAgentId: req.agentId,
      coordinatorAgentId: coordinatorAgentId as never,
      createdAt: clock(),
      expiresAt: req.expiresAt,
    } satisfies PermissionEscalationRequestRecord,
  });
  return sendResult.ok ? undefined : rejectDecision(sendResult.error.message);
}

async function pollForDecision(
  mailbox: NexusMailboxClient,
  req: EscalationRequest,
  coordinatorAgentId: string,
  clock: () => number,
  pollIntervalMs: number,
): Promise<EscalationDecision> {
  while (clock() < req.expiresAt) {
    const result = await findExistingDecision(mailbox, req, coordinatorAgentId);
    if (result.kind === "found" || result.kind === "error") return result.decision;
    if (pollIntervalMs > 0) await Bun.sleep(pollIntervalMs);
  }
  return timeoutDecision();
}

async function executeEscalationRequest(
  config: NexusPermissionEscalationConfig,
  mailbox: NexusMailboxClient,
  clock: () => number,
  req: EscalationRequest,
): Promise<EscalationDecision> {
  if (req.expiresAt <= clock()) return timeoutDecision();
  if (req.agentId !== config.agentId) {
    return rejectDecision("permission escalation agentId does not match bound client identity");
  }

  // Reconnect-safe resume: check inbox for an already-persisted matching
  // decision before sending a new request.
  const existing = await findExistingDecision(mailbox, req, config.coordinatorAgentId);
  if (existing.kind === "found" || existing.kind === "error") return existing.decision;

  const sendError = await sendEscalationRequest(mailbox, req, config.coordinatorAgentId, clock);
  if (sendError !== undefined) return sendError;

  return pollForDecision(
    mailbox,
    req,
    config.coordinatorAgentId,
    clock,
    config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
}

export function createNexusPermissionEscalation(
  config: NexusPermissionEscalationConfig,
): PermissionEscalation {
  const validated = validateNexusPermissionEscalationConfig(config);
  if (!validated.ok) throw new Error(validated.error.message);

  const mailbox = createNexusMailboxClient(config.transport, config.requestMethodPrefix ?? "ipc");
  const clock = config.clock ?? Date.now;

  return {
    request: (req: EscalationRequest) => executeEscalationRequest(config, mailbox, clock, req),
  };
}
