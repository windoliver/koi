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
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { CreateSoulOptions } from "./config.js";
import {
  DEFAULT_SOUL_MAX_TOKENS,
  DEFAULT_USER_MAX_TOKENS,
  extractInput,
  extractMaxTokens,
} from "./config.js";
import type { ResolvedContent } from "./resolve.js";
import { resolveSoulContent, resolveUserContent } from "./resolve.js";

/**
 * Extended middleware with a `reload()` method for HITL-approved soul updates.
 *
 * Automatically reloads when `fs_write` targets a tracked soul/user file
 * (the write must pass through the middleware chain, including permissions/HITL).
 * Manual `reload()` is also available for programmatic use.
 */
export interface SoulMiddleware extends KoiMiddleware {
  /**
   * Re-resolves all soul and user content from original source paths.
   * Called automatically after successful `fs_write` to tracked files.
   * Can also be called manually after HITL-approved writes.
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

/** Result of resolving soul or user content, including source file paths. */
interface ResolveResult {
  readonly text: string;
  readonly sources: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Resolves soul content from options, returning text, sources, and warnings.
 * Shared between initial load and reload.
 */
async function resolveSoul(options: CreateSoulOptions): Promise<ResolveResult> {
  if (options.soul === undefined) return { text: "", sources: [], warnings: [] };
  const input = extractInput(options.soul);
  const maxTokens = extractMaxTokens(options.soul, DEFAULT_SOUL_MAX_TOKENS);
  const resolved: ResolvedContent = await resolveSoulContent({
    input,
    maxTokens,
    label: "soul",
    basePath: options.basePath,
  });
  return { text: resolved.text, sources: resolved.sources, warnings: resolved.warnings };
}

/**
 * Resolves user content from options, returning text, sources, and warnings.
 * Shared between initial load, reload, and per-call refresh.
 */
async function resolveUser(options: CreateSoulOptions): Promise<ResolveResult> {
  if (options.user === undefined) return { text: "", sources: [], warnings: [] };
  const input = extractInput(options.user);
  const maxTokens = extractMaxTokens(options.user, DEFAULT_USER_MAX_TOKENS);
  const resolved: ResolvedContent = await resolveUserContent({
    input,
    maxTokens,
    label: "user",
    basePath: options.basePath,
  });
  return { text: resolved.text, sources: resolved.sources, warnings: resolved.warnings };
}

function emitWarnings(warnings: readonly string[]): void {
  for (const w of warnings) {
    console.warn(`[soul middleware] ${w}`);
  }
}

/**
 * Builds a Set of tracked file paths from resolved sources.
 * Excludes "inline" (no file to watch).
 */
function buildWatchedPaths(
  soulSources: readonly string[],
  userSources: readonly string[],
): Set<string> {
  const paths = new Set<string>();
  for (const s of soulSources) {
    if (s !== "inline") paths.add(s);
  }
  for (const s of userSources) {
    if (s !== "inline") paths.add(s);
  }
  return paths;
}

/**
 * Creates a soul middleware that injects agent personality and user context
 * into model calls as a system message prefix.
 *
 * Returns `SoulMiddleware` — a `KoiMiddleware` with `reload()` and auto-reload
 * via `wrapToolCall`. When `fs_write` targets a tracked soul/user file and
 * succeeds (meaning it passed permissions/HITL), the middleware auto-reloads.
 *
 * Soul and user content are resolved at factory time and cached in the closure.
 * User content can optionally be refreshed per-call with `refreshUser: true`.
 * Both soul and user are re-resolved atomically when `reload()` is called.
 */
export async function createSoulMiddleware(options: CreateSoulOptions): Promise<SoulMiddleware> {
  const { refreshUser = false } = options;

  // Mutable closure state — updated atomically by reload()
  let soulText = ""; // let: reassigned by reload()
  let userText = ""; // let: reassigned by reload()
  let cachedMessage: InboundMessage | undefined; // let: reassigned by reload()
  let watchedPaths: Set<string>; // let: rebuilt on reload() when directory contents change

  // Initial resolution
  const soulResult = await resolveSoul(options);
  soulText = soulResult.text;
  emitWarnings(soulResult.warnings);

  const userResult = await resolveUser(options);
  userText = userResult.text;
  emitWarnings(userResult.warnings);

  cachedMessage = buildSoulMessage(soulText, userText);
  watchedPaths = buildWatchedPaths(soulResult.sources, userResult.sources);

  async function getSoulMessage(): Promise<InboundMessage | undefined> {
    if (!refreshUser || options.user === undefined) return cachedMessage;

    // Re-resolve user content only (soul stays cached until reload())
    const resolved = await resolveUser(options);
    return buildSoulMessage(soulText, resolved.text);
  }

  async function reload(): Promise<void> {
    const [newSoul, newUser] = await Promise.all([resolveSoul(options), resolveUser(options)]);
    emitWarnings(newSoul.warnings);
    emitWarnings(newUser.warnings);

    // Atomic update — text, message, and watched paths all change together
    soulText = newSoul.text;
    userText = newUser.text;
    cachedMessage = buildSoulMessage(soulText, userText);
    watchedPaths = buildWatchedPaths(newSoul.sources, newUser.sources);
  }

  return {
    name: "soul",
    priority: 500,

    reload,

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const response = await next(request);

      // Auto-reload after successful fs_write to a tracked soul/user file
      if (request.toolId === "fs_write" && watchedPaths.size > 0) {
        const writtenPath = typeof request.input.path === "string" ? request.input.path : undefined;
        if (writtenPath !== undefined && watchedPaths.has(writtenPath)) {
          await reload().catch((err: unknown) => console.error("[soul] reload failed:", err));
        }
      }

      return response;
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
