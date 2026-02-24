/**
 * Soul middleware factory — markdown-based agent character + user context injection.
 */

import type { InboundMessage } from "@koi/core/message";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core/middleware";
import type { CreateSoulOptions } from "./config.js";
import {
  DEFAULT_SOUL_MAX_TOKENS,
  DEFAULT_USER_MAX_TOKENS,
  extractInput,
  extractMaxTokens,
} from "./config.js";
import { resolveSoulContent, resolveUserContent } from "./resolve.js";

/**
 * Extended middleware with a `reload()` method for HITL-approved soul updates.
 *
 * When forge + permissions approves a write to SOUL.md/USER.md, call `reload()`
 * to re-resolve all markdown content from disk. Without `reload()`, the closure
 * cache protects the running agent against unauthorized modifications.
 */
export interface SoulMiddleware extends KoiMiddleware {
  /**
   * Re-resolves all soul and user content from original source paths.
   * Call after HITL-approved writes to personality/user markdown files.
   * Updates the running middleware atomically — takes effect on next model call.
   */
  readonly reload: () => Promise<void>;
}

/**
 * Enriches a model request by prepending a soul system message.
 * Pure function — does not mutate the input request.
 */
export function enrichRequest(
  request: ModelRequest,
  soulMessage: InboundMessage | undefined,
): ModelRequest {
  if (soulMessage === undefined) return request;
  return { ...request, messages: [soulMessage, ...request.messages] };
}

function buildSoulMessage(soulText: string, userText: string): InboundMessage | undefined {
  const parts: string[] = [];
  if (soulText.length > 0) parts.push(soulText);
  if (userText.length > 0) parts.push(userText);

  if (parts.length === 0) return undefined;

  return {
    senderId: "system:soul",
    timestamp: Date.now(),
    content: [{ kind: "text", text: parts.join("\n\n") }],
  };
}

/**
 * Resolves soul content from options, returning text and warnings.
 * Shared between initial load and reload.
 */
async function resolveSoul(
  options: CreateSoulOptions,
): Promise<{ readonly text: string; readonly warnings: readonly string[] }> {
  if (options.soul === undefined) return { text: "", warnings: [] };
  const input = extractInput(options.soul);
  const maxTokens = extractMaxTokens(options.soul, DEFAULT_SOUL_MAX_TOKENS);
  const resolved = await resolveSoulContent({
    input,
    maxTokens,
    label: "soul",
    basePath: options.basePath,
  });
  return { text: resolved.text, warnings: resolved.warnings };
}

/**
 * Resolves user content from options, returning text and warnings.
 * Shared between initial load, reload, and per-call refresh.
 */
async function resolveUser(
  options: CreateSoulOptions,
): Promise<{ readonly text: string; readonly warnings: readonly string[] }> {
  if (options.user === undefined) return { text: "", warnings: [] };
  const input = extractInput(options.user);
  const maxTokens = extractMaxTokens(options.user, DEFAULT_USER_MAX_TOKENS);
  const resolved = await resolveUserContent({
    input,
    maxTokens,
    label: "user",
    basePath: options.basePath,
  });
  return { text: resolved.text, warnings: resolved.warnings };
}

function emitWarnings(warnings: readonly string[]): void {
  for (const w of warnings) {
    console.warn(`[soul middleware] ${w}`);
  }
}

/**
 * Creates a soul middleware that injects agent personality and user context
 * into model calls as a system message prefix.
 *
 * Returns `SoulMiddleware` — a `KoiMiddleware` with an additional `reload()` method.
 * Call `reload()` after HITL-approved writes to soul/user markdown files.
 *
 * Soul and user content are resolved at factory time and cached in the closure.
 * User content can optionally be refreshed per-call with `refreshUser: true`.
 * Both soul and user are re-resolved atomically when `reload()` is called.
 */
export async function createSoulMiddleware(options: CreateSoulOptions): Promise<SoulMiddleware> {
  const { refreshUser = false } = options;

  // Mutable closure state — updated atomically by reload()
  // let: reassigned by reload()
  let soulText = ""; // let: reassigned by reload()
  let userText = ""; // let: reassigned by reload()
  let cachedMessage: InboundMessage | undefined; // let: reassigned by reload()

  // Initial resolution
  const soulResult = await resolveSoul(options);
  soulText = soulResult.text;
  emitWarnings(soulResult.warnings);

  const userResult = await resolveUser(options);
  userText = userResult.text;
  emitWarnings(userResult.warnings);

  cachedMessage = buildSoulMessage(soulText, userText);

  async function getSoulMessage(): Promise<InboundMessage | undefined> {
    if (!refreshUser || options.user === undefined) return cachedMessage;

    // Re-resolve user content only (soul stays cached until reload())
    const resolved = await resolveUser(options);
    return buildSoulMessage(soulText, resolved.text);
  }

  return {
    name: "soul",
    priority: 500,

    async reload(): Promise<void> {
      const [newSoul, newUser] = await Promise.all([resolveSoul(options), resolveUser(options)]);
      emitWarnings(newSoul.warnings);
      emitWarnings(newUser.warnings);

      // Atomic update — both change together
      soulText = newSoul.text;
      userText = newUser.text;
      cachedMessage = buildSoulMessage(soulText, userText);
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const message = await getSoulMessage();
      return next(enrichRequest(request, message));
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<import("@koi/core/middleware").ModelChunk> {
      const message = await getSoulMessage();
      yield* next(enrichRequest(request, message));
    },
  };
}
