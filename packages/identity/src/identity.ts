/**
 * Identity middleware factory — per-channel persona injection with hot-reload.
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
import type { CreateIdentityOptions } from "./config.js";
import type { CachedPersona } from "./persona-map.js";
import { buildPersonaMap, buildWatchedPaths } from "./persona-map.js";

/**
 * Extended middleware with a `reload()` method for hot-reloading persona config.
 *
 * Automatically reloads when `fs_write` targets a tracked persona instruction file.
 * Manual `reload()` is also available for programmatic use.
 */
export interface IdentityMiddleware extends KoiMiddleware {
  /**
   * Re-resolves all persona instruction files and rebuilds the persona map.
   * Called automatically after successful `fs_write` to a tracked file.
   * Can also be called manually after out-of-band file changes.
   * Takes effect on the next model call.
   */
  readonly reload: () => Promise<void>;
  // All three hooks are always implemented — narrow the optional to required.
  readonly wrapToolCall: NonNullable<KoiMiddleware["wrapToolCall"]>;
  readonly wrapModelCall: NonNullable<KoiMiddleware["wrapModelCall"]>;
  readonly wrapModelStream: NonNullable<KoiMiddleware["wrapModelStream"]>;
}

/**
 * Enriches a model request by prepending a persona system message.
 * Pure function — does not mutate the input request.
 */
export function enrichRequest(request: ModelRequest, personaMessage: InboundMessage): ModelRequest {
  return { ...request, messages: [personaMessage, ...request.messages] };
}

/**
 * Creates an identity middleware that injects per-channel persona system messages
 * into model calls, keyed by `SessionContext.channelId`.
 *
 * Priority 490 — runs just outside soul middleware (500) so identity wraps outermost.
 *
 * Returns `IdentityMiddleware` — a `KoiMiddleware` with `reload()` and auto-reload
 * via `wrapToolCall` when `fs_write` targets a tracked instruction file.
 */
export async function createIdentityMiddleware(
  options: CreateIdentityOptions,
): Promise<IdentityMiddleware> {
  // Mutable closure state — updated atomically by reload()
  // let: reassigned by reload()
  let personaMap: Map<string, CachedPersona> = await buildPersonaMap(options);
  let watchedPaths: Set<string> = buildWatchedPaths(personaMap);

  async function reload(): Promise<void> {
    const newMap = await buildPersonaMap(options);
    // Atomic update — both map and watched paths change together
    personaMap = newMap;
    watchedPaths = buildWatchedPaths(newMap);
  }

  return {
    name: "identity",
    // Priority 490: slightly ahead of soul (500) so identity wraps outside soul
    priority: 490,

    reload,

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const response = await next(request);

      // Auto-reload after successful fs_write to a tracked instruction file
      if (request.toolId === "fs_write" && watchedPaths.size > 0) {
        const writtenPath = typeof request.input.path === "string" ? request.input.path : undefined;
        if (writtenPath !== undefined && watchedPaths.has(writtenPath)) {
          await reload().catch((err: unknown) => console.error("[identity] reload failed:", err));
        }
      }

      return response;
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const channelId = ctx.session.channelId;
      const cached = channelId !== undefined ? personaMap.get(channelId) : undefined;
      const enriched = cached !== undefined ? enrichRequest(request, cached.message) : request;
      return next(enriched);
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<import("@koi/core/middleware").ModelChunk> {
      const channelId = ctx.session.channelId;
      const cached = channelId !== undefined ? personaMap.get(channelId) : undefined;
      const enriched = cached !== undefined ? enrichRequest(request, cached.message) : request;
      yield* next(enriched);
    },
  };
}
