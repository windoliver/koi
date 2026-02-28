/**
 * createIntentCapsuleMiddleware — cryptographic mandate binding for ASI01 defense.
 *
 * Implements OWASP ASI01 (Agentic Goal Hijacking) defense via:
 * 1. onSessionStart: sign the agent mandate (system prompt + objectives) with Ed25519
 * 2. wrapModelCall: verify mandate integrity via hash comparison (no crypto on hot path)
 * 3. onSessionEnd: cleanup + TTL eviction to prevent memory leaks
 *
 * If the mandate hash does not match the stored capsule, a KoiRuntimeError with
 * code "PERMISSION" and reason "capsule_violation" is thrown — halting the turn.
 *
 * Middleware name: "intent-capsule"
 * Priority: 290 (runs before permissions at ~300, after audit layers)
 *
 * Depends on @koi/core, @koi/crypto-utils, @koi/errors.
 */

import type { CapsuleVerifier, IntentCapsule } from "@koi/core/intent-capsule";
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
import { generateEd25519KeyPair, sha256Hex, signEd25519 } from "@koi/crypto-utils";
import { KoiRuntimeError } from "@koi/errors";
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

/**
 * Creates the intent capsule middleware.
 *
 * @param config - Mandate fields + behaviour options.
 * @returns KoiMiddleware implementing ASI01 cryptographic mandate binding.
 */
export function createIntentCapsuleMiddleware(config: IntentCapsuleConfig): KoiMiddleware {
  const resolved = resolveConfig(config);
  // Map keyed by raw sessionId string for efficient lookup
  const sessions = new Map<string, CapsuleEntry>();

  return {
    name: "intent-capsule",
    priority: 290,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return { label: "intent-capsule", description: "Mandate cryptographically bound (Ed25519)" };
    },

    async onSessionStart(ctx: SessionContext): Promise<void> {
      evictStaleSessions(sessions, resolved.maxTtlMs);

      const mandatePayload = canonicalizeMandatePayload({
        agentId: ctx.agentId,
        sessionId: ctx.sessionId as string,
        systemPrompt: resolved.systemPrompt,
        objectives: resolved.objectives,
      });

      const mandateHash = sha256Hex(mandatePayload);
      const { publicKeyDer, privateKeyDer } = generateEd25519KeyPair();
      const signature = signEd25519(mandateHash, privateKeyDer);
      const now = Date.now();

      const capsule: IntentCapsule = {
        id: capsuleId(`${ctx.agentId}:${ctx.sessionId as string}:${now}`),
        agentId: ctx.agentId as IntentCapsule["agentId"],
        sessionId: ctx.sessionId as IntentCapsule["sessionId"],
        mandateHash,
        signature,
        publicKey: publicKeyDer,
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

/** Verifies the capsule for the current turn. Throws on violation. */
async function verifyCapsule(
  ctx: TurnContext,
  resolved: ReturnType<typeof resolveConfig>,
  sessions: Map<string, CapsuleEntry>,
): Promise<void> {
  const entry = sessions.get(ctx.session.sessionId as string);
  if (entry === undefined) {
    throw KoiRuntimeError.from("PERMISSION", "Intent capsule not found for session", {
      retryable: false,
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
  const currentMandateHash = sha256Hex(currentPayload);

  const result = await (resolved.verifier as CapsuleVerifier).verify(
    entry.capsule,
    currentMandateHash,
  );

  if (!result.ok) {
    throw KoiRuntimeError.from(
      "PERMISSION",
      "Intent capsule violation: mandate has been tampered",
      {
        retryable: false,
        context: {
          sessionId: ctx.session.sessionId as string,
          reason: "capsule_violation",
          detail: result.reason,
          capsuleId: entry.capsule.id,
        },
      },
    );
  }
}

/**
 * Evict session entries older than maxTtlMs.
 * Called at onSessionStart to prevent memory leaks from abnormal terminations.
 */
function evictStaleSessions(sessions: Map<string, CapsuleEntry>, maxTtlMs: number): void {
  const cutoff = Date.now() - maxTtlMs;
  for (const [key, entry] of sessions) {
    if (entry.createdAt < cutoff) {
      sessions.delete(key);
    }
  }
}

/**
 * Injects the signed mandate as a system message at the front of the request.
 * Gives the model a cryptographically-bound reference to its original mission.
 */
function injectMandateMessage(
  request: ModelRequest,
  capsule: IntentCapsule | undefined,
): ModelRequest {
  if (capsule === undefined) return request;

  const mandateText = buildMandateText(capsule);
  return {
    ...request,
    messages: [
      {
        senderId: "system:intent-capsule",
        timestamp: capsule.createdAt,
        content: [{ kind: "text", text: mandateText }],
      },
      ...request.messages,
    ],
  };
}

function buildMandateText(capsule: IntentCapsule): string {
  return [
    "[Signed Mandate — v1]",
    `Agent:     ${capsule.agentId}`,
    `Session:   ${capsule.sessionId}`,
    `Hash:      ${capsule.mandateHash}`,
    `Signature: ${capsule.signature}`,
    "[/Signed Mandate]",
  ].join("\n");
}
