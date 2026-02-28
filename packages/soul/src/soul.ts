/**
 * Unified soul middleware factory — three composable layers of system prompt injection.
 *
 * Merges @koi/middleware-soul and @koi/identity into a single middleware at priority 500.
 * Layers: soul (global) + identity (per-channel) + user (per-user), concatenated in order.
 */

import type { InboundMessage } from "@koi/core/message";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { ResolvedContent } from "@koi/file-resolution";
import { resolveContent } from "@koi/file-resolution";
import type { CreateSoulOptions } from "./config.js";
import {
  DEFAULT_SOUL_MAX_TOKENS,
  DEFAULT_USER_MAX_TOKENS,
  extractInput,
  extractMaxTokens,
} from "./config.js";
import { createPersonaMap } from "./persona-map.js";
import type { SoulState } from "./state.js";
import { createAllWatchedPaths, createSoulMessage, generateMetaInstructionText } from "./state.js";

/**
 * Extended middleware with a `reload()` method for HITL-approved soul updates.
 *
 * Automatically reloads when `fs_write` targets a tracked soul/identity/user file
 * (the write must pass through the middleware chain, including permissions/HITL).
 * Manual `reload()` is also available for programmatic use.
 */
export interface SoulMiddleware extends KoiMiddleware {
  /**
   * Re-resolves all soul, identity, and user content from original source paths.
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

/** Result of resolving soul or user content. */
interface ResolveResult {
  readonly text: string;
  readonly sources: readonly string[];
  readonly warnings: readonly string[];
}

async function resolveSoulLayer(options: CreateSoulOptions): Promise<ResolveResult> {
  if (options.soul === undefined) return { text: "", sources: [], warnings: [] };
  const input = extractInput(options.soul);
  const maxTokens = extractMaxTokens(options.soul, DEFAULT_SOUL_MAX_TOKENS);
  const resolved: ResolvedContent = await resolveContent({
    input,
    maxTokens,
    label: "soul",
    basePath: options.basePath,
    allowDirectory: true,
  });
  return { text: resolved.text, sources: resolved.sources, warnings: resolved.warnings };
}

async function resolveUserLayer(options: CreateSoulOptions): Promise<ResolveResult> {
  if (options.user === undefined) return { text: "", sources: [], warnings: [] };
  const input = extractInput(options.user);
  const maxTokens = extractMaxTokens(options.user, DEFAULT_USER_MAX_TOKENS);
  const resolved: ResolvedContent = await resolveContent({
    input,
    maxTokens,
    label: "user",
    basePath: options.basePath,
    allowDirectory: false,
  });
  return { text: resolved.text, sources: resolved.sources, warnings: resolved.warnings };
}

function emitWarnings(warnings: readonly string[]): void {
  for (const w of warnings) {
    console.warn(`[soul middleware] ${w}`);
  }
}

/**
 * Creates the full SoulState from all three layers.
 */
async function createState(options: CreateSoulOptions): Promise<SoulState> {
  const [soulResult, personaMap, userResult] = await Promise.all([
    resolveSoulLayer(options),
    createPersonaMap(options.identity?.personas ?? [], options.basePath),
    resolveUserLayer(options),
  ]);

  emitWarnings(soulResult.warnings);
  emitWarnings(userResult.warnings);

  const watchedPaths = createAllWatchedPaths(soulResult.sources, personaMap, userResult.sources);
  const selfModify = options.selfModify ?? true;

  // Collect identity file paths from all personas for meta-instruction
  const identitySources = Array.from(personaMap.values()).flatMap((cached) => [...cached.sources]);
  const metaInstructionText = generateMetaInstructionText(
    { soul: soulResult.sources, identity: identitySources, user: userResult.sources },
    selfModify,
  );

  return {
    soulText: soulResult.text,
    soulSources: soulResult.sources,
    personaMap,
    userText: userResult.text,
    userSources: userResult.sources,
    watchedPaths,
    metaInstructionText,
  };
}

/**
 * Creates a unified soul middleware that injects agent personality, per-channel
 * identity, and user context into model calls as a system message prefix.
 *
 * Returns `SoulMiddleware` — a `KoiMiddleware` with `reload()` and auto-reload
 * via `wrapToolCall`. When `fs_write` targets a tracked file and succeeds
 * (meaning it passed permissions/HITL), the middleware auto-reloads.
 *
 * Content is resolved at factory time and cached in the closure.
 * User content can optionally be refreshed per-call with `refreshUser: true`.
 * All layers are re-resolved atomically when `reload()` is called.
 */
export async function createSoulMiddleware(options: CreateSoulOptions): Promise<SoulMiddleware> {
  const { refreshUser = false } = options;

  // Mutable closure state — updated atomically by reload()
  let state: SoulState = await createState(options); // let: reassigned by reload()

  function getSoulMessage(ctx: TurnContext): InboundMessage | undefined {
    // Look up identity text for the current channel
    const channelId = ctx.session.channelId;
    const cached = channelId !== undefined ? state.personaMap.get(channelId) : undefined;
    const identityText = cached?.text;

    return createSoulMessage(
      state.soulText,
      identityText,
      state.userText,
      state.metaInstructionText,
    );
  }

  async function getSoulMessageAsync(ctx: TurnContext): Promise<InboundMessage | undefined> {
    if (!refreshUser || options.user === undefined) return getSoulMessage(ctx);

    // Re-resolve user content only (soul + identity stay cached until reload())
    const userResult = await resolveUserLayer(options);
    const channelId = ctx.session.channelId;
    const cached = channelId !== undefined ? state.personaMap.get(channelId) : undefined;
    return createSoulMessage(
      state.soulText,
      cached?.text,
      userResult.text,
      state.metaInstructionText,
    );
  }

  async function reload(): Promise<void> {
    state = await createState(options);
  }

  const selfModify = options.selfModify ?? true;

  return {
    name: "soul",
    priority: 500,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => ({
      label: "soul",
      description:
        `Persona system prompt injected` +
        (state.personaMap.size > 0
          ? `, ${String(state.personaMap.size)} per-channel persona(s)`
          : "") +
        (refreshUser ? ", user context refreshed per call" : "") +
        (selfModify && state.metaInstructionText.length > 0 ? ", self-modification enabled" : "") +
        (state.watchedPaths.size > 0
          ? `, auto-reload on fs_write to ${String(state.watchedPaths.size)} tracked file(s)`
          : ""),
    }),

    reload,

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const response = await next(request);

      // Auto-reload after successful fs_write to a tracked file
      if (request.toolId === "fs_write" && state.watchedPaths.size > 0) {
        const writtenPath = typeof request.input.path === "string" ? request.input.path : undefined;
        if (writtenPath !== undefined && state.watchedPaths.has(writtenPath)) {
          await reload().catch((err: unknown) => console.error("[soul] reload failed:", err));
        }
      }

      return response;
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const message = await getSoulMessageAsync(ctx);
      return next(enrichRequest(request, message));
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const message = await getSoulMessageAsync(ctx);
      yield* next(enrichRequest(request, message));
    },
  };
}
