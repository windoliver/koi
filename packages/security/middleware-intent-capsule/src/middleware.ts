import { generateKeyPairSync, sign } from "node:crypto";
import { agentId as toAgentId } from "@koi/core";
import type { IntentCapsule } from "@koi/core/intent-capsule";
import { capsuleId } from "@koi/core/intent-capsule";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { computeStringHash } from "@koi/hash";
import { canonicalizeMandatePayload } from "./canonicalize.js";
import { type IntentCapsuleConfig, resolveConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

interface CapsuleEntry {
  readonly capsule: IntentCapsule;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function createIntentCapsuleMiddleware(config: IntentCapsuleConfig): KoiMiddleware {
  const resolved = resolveConfig(config);
  const sessions = new Map<string, CapsuleEntry>();

  return {
    name: "intent-capsule",
    priority: 290,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return {
        label: "intent-capsule",
        description: "Mandate cryptographically bound (Ed25519)",
      };
    },

    async onSessionStart(ctx: SessionContext): Promise<void> {
      evictStaleSessions(sessions, resolved.maxTtlMs);

      const mandatePayload = canonicalizeMandatePayload({
        agentId: ctx.agentId,
        sessionId: ctx.sessionId as string,
        systemPrompt: resolved.systemPrompt,
        objectives: resolved.objectives,
      });

      const mandateHash = computeStringHash(mandatePayload);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const signature = sign(null, Buffer.from(mandateHash), privateKey).toString("base64");
      const publicKeyB64 = Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString(
        "base64",
      );
      const now = Date.now();

      const capsule: IntentCapsule = {
        id: capsuleId(`${ctx.agentId}:${ctx.sessionId as string}:${now}`),
        agentId: toAgentId(ctx.agentId),
        sessionId: ctx.sessionId,
        mandateHash,
        signature,
        publicKey: publicKeyB64,
        createdAt: now,
        version: 1,
      };

      sessions.set(ctx.sessionId as string, { capsule, createdAt: now });
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      await verifyCapsule(ctx, resolved, sessions);
      const enriched = resolved.injectMandate
        ? injectMandateMessage(request, sessions.get(ctx.session.sessionId as string)?.capsule)
        : request;
      return next(enriched);
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      await verifyCapsule(ctx, resolved, sessions);
      const enriched = resolved.injectMandate
        ? injectMandateMessage(request, sessions.get(ctx.session.sessionId as string)?.capsule)
        : request;
      yield* next(enriched);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      sessions.delete(ctx.sessionId as string);
    },
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function verifyCapsule(
  ctx: TurnContext,
  resolved: Required<IntentCapsuleConfig>,
  sessions: Map<string, CapsuleEntry>,
): Promise<void> {
  const entry = sessions.get(ctx.session.sessionId as string);
  if (entry === undefined) {
    throw KoiRuntimeError.from("PERMISSION", "Intent capsule not found for session", {
      context: {
        sessionId: ctx.session.sessionId as string,
        reason: "capsule_violation",
        detail: "capsule_not_found",
      },
    });
  }

  const currentPayload = canonicalizeMandatePayload({
    agentId: ctx.session.agentId,
    sessionId: ctx.session.sessionId as string,
    systemPrompt: resolved.systemPrompt,
    objectives: resolved.objectives,
  });
  const currentMandateHash = computeStringHash(currentPayload);

  const result = await resolved.verifier.verify(entry.capsule, currentMandateHash);

  if (!result.ok) {
    throw KoiRuntimeError.from(
      "PERMISSION",
      "Intent capsule violation: mandate has been tampered",
      {
        context: {
          sessionId: ctx.session.sessionId as string,
          reason: "capsule_violation",
          detail: result.reason,
          capsuleId: entry.capsule.id as string,
        },
      },
    );
  }
}

function evictStaleSessions(sessions: Map<string, CapsuleEntry>, maxTtlMs: number): void {
  const cutoff = Date.now() - maxTtlMs;
  for (const [key, entry] of sessions) {
    if (entry.createdAt < cutoff) {
      sessions.delete(key);
    }
  }
}

function injectMandateMessage(
  request: ModelRequest,
  capsule: IntentCapsule | undefined,
): ModelRequest {
  if (capsule === undefined) return request;
  return {
    ...request,
    messages: [
      {
        senderId: "system:intent-capsule",
        timestamp: capsule.createdAt,
        content: [
          {
            kind: "text",
            text: [
              "[Signed Mandate — v1]",
              `Agent:     ${capsule.agentId}`,
              `Session:   ${capsule.sessionId as string}`,
              `Hash:      ${capsule.mandateHash}`,
              `Signature: ${capsule.signature}`,
              "[/Signed Mandate]",
            ].join("\n"),
          },
        ],
      },
      ...request.messages,
    ],
  };
}
