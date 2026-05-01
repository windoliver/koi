/**
 * Tool disclosure middleware — progressive disclosure for large tool sets.
 *
 * Above a configurable threshold, replaces full ToolDescriptor[] with summaries
 * (name + description, empty inputSchema) in the model request. Tools are
 * promoted to full descriptor level on demand via the `promote_tools` companion
 * tool. Below the threshold, all tools pass through unchanged.
 *
 * Promotion state is keyed by SessionId so concurrent or interleaved sessions
 * sharing one middleware instance cannot corrupt each other's promoted set.
 * Per-session entries are populated on `onSessionStart` and torn down on
 * `onSessionEnd`. Promotion requests from the model arrive through
 * `wrapToolCall` and are routed by `ctx.session.sessionId` — there is no
 * implicit "active session" routing, so interleaved tool calls from two
 * sessions on one middleware instance never cross-write each other's state.
 */

import type {
  CapabilityFragment,
  JsonObject,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  SessionId,
  ToolDescriptor,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";

/** Default tool count threshold below which disclosure is bypassed. */
export const DEFAULT_DISCLOSURE_THRESHOLD = 50;

/** Name of the companion tool that promotes summary-level tools to full descriptors. */
export const PROMOTE_TOOL_NAME = "promote_tools";

export interface ToolDisclosureConfig {
  /**
   * Tool count threshold. Below this, all tools pass through unchanged.
   * Above this, tools are exposed at summary level with on-demand promotion.
   * Default: 50.
   */
  readonly threshold?: number;
}

export interface ToolDisclosureMiddleware extends KoiMiddleware {
  /**
   * Promote tools by name for an explicit session. Returns the names actually
   * promoted; an empty array if the session is unknown or names are not in
   * the session's most recent input descriptor list.
   */
  readonly promoteByNameForSession: (
    sessionId: SessionId,
    names: readonly string[],
  ) => readonly string[];
  /** Drop all per-session promotion state. Useful for tests. */
  readonly clearCache: () => void;
  /**
   * Notify the middleware that the `promote_tools` companion tool has been
   * registered. When set, `describeCapabilities` advertises the companion tool.
   * Without this call (standalone use), the capability fragment is suppressed.
   */
  readonly notifyCompanionRegistered: () => void;
}

interface SessionState {
  promoted: Set<string>;
  knownNames: ReadonlySet<string>;
}

interface PromoteResult extends JsonObject {
  readonly ok: boolean;
  readonly promoted?: readonly string[];
  readonly message?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

function summarize(tool: ToolDescriptor): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {},
    ...(tool.tags !== undefined && tool.tags.length > 0 ? { tags: tool.tags } : {}),
  };
}

function validatePromoteInput(
  input: JsonObject,
):
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly response: ToolResponse } {
  const names = input.names;
  if (!Array.isArray(names)) {
    return {
      ok: false,
      response: {
        output: {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `${PROMOTE_TOOL_NAME} requires a 'names' array of tool name strings`,
          },
        } satisfies PromoteResult,
      },
    };
  }
  const stringNames: readonly string[] = names.filter(
    (n: unknown): n is string => typeof n === "string",
  );
  if (stringNames.length === 0) {
    return {
      ok: false,
      response: {
        output: {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `${PROMOTE_TOOL_NAME} requires at least one tool name string`,
          },
        } satisfies PromoteResult,
      },
    };
  }
  return { ok: true, names: stringNames };
}

export function createToolDisclosureMiddleware(
  config?: ToolDisclosureConfig,
): ToolDisclosureMiddleware {
  const threshold = config?.threshold ?? DEFAULT_DISCLOSURE_THRESHOLD;

  // Per-session state map. Populated on session start, torn down on session end.
  // let justified: mutable map keyed by SessionId.
  const sessions = new Map<SessionId, SessionState>();

  // let justified: mutable flag — set once by notifyCompanionRegistered().
  let companionToolRegistered = false;

  function getOrCreate(sid: SessionId): SessionState {
    let state = sessions.get(sid);
    if (state === undefined) {
      state = { promoted: new Set<string>(), knownNames: new Set<string>() };
      sessions.set(sid, state);
    }
    return state;
  }

  function disclose(
    state: SessionState,
    tools: readonly ToolDescriptor[],
  ): readonly ToolDescriptor[] {
    if (tools.length <= threshold) return tools;
    const result: ToolDescriptor[] = [];
    const names = new Set<string>();
    for (const tool of tools) {
      names.add(tool.name);
      if (state.promoted.has(tool.name) || tool.name === PROMOTE_TOOL_NAME) {
        result.push(tool);
      } else {
        result.push(summarize(tool));
      }
    }
    // Drop promotions for names no longer in the current tool list. A tool
    // descriptor that was previously promoted may have been swapped, retired,
    // or replaced by a different implementation under the same name (selector
    // middleware, tenant rotation). Re-promotion is the safe gate.
    for (const name of state.promoted) {
      if (!names.has(name)) state.promoted.delete(name);
    }
    state.knownNames = names;
    return result;
  }

  function promoteForSession(sid: SessionId, names: readonly string[]): readonly string[] {
    const state = sessions.get(sid);
    if (state === undefined) return [];
    const ok: string[] = [];
    for (const name of names) {
      if (state.knownNames.has(name)) {
        state.promoted.add(name);
        ok.push(name);
      }
    }
    return ok;
  }

  const middleware: ToolDisclosureMiddleware = {
    name: "tool-disclosure",
    priority: 50,
    phase: "intercept",

    async onSessionStart(ctx: SessionContext): Promise<void> {
      getOrCreate(ctx.sessionId);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      sessions.delete(ctx.sessionId);
    },

    wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      if (request.tools === undefined) {
        return next(request);
      }
      if (request.tools.length <= threshold) {
        // Below-threshold: the model sees FULL schemas, so every advertised
        // tool is implicitly promoted. Populate knownNames + promoted with
        // the current set so wrapToolCall still rejects stale/leaked names
        // not in the latest advertised list (covers dynamic shrinkage where
        // a tool drops out but is still registered upstream).
        const state = getOrCreate(ctx.session.sessionId);
        const names = new Set<string>();
        for (const tool of request.tools) names.add(tool.name);
        state.knownNames = names;
        state.promoted = new Set(names);
        return next(request);
      }
      const state = getOrCreate(ctx.session.sessionId);
      const disclosed = disclose(state, request.tools);
      return next({ ...request, tools: disclosed });
    },

    /**
     * Intercept `promote_tools` calls and route them by `ctx.session.sessionId`.
     * Also fail-closed against direct calls to summary-level tools — their
     * advertised inputSchema is empty so the engine's argument validation
     * accepts anything; the model must promote them first so the real schema
     * is what validates args.
     */
    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      if (request.toolId === PROMOTE_TOOL_NAME) {
        const validated = validatePromoteInput(request.input);
        if (!validated.ok) return validated.response;

        const promoted = promoteForSession(ctx.session.sessionId, validated.names);
        const result: PromoteResult = {
          ok: true,
          promoted,
          message:
            promoted.length > 0
              ? `Promoted ${promoted.length} tool(s): ${promoted.join(", ")}. Full schemas are now available.`
              : "No tools were promoted. Check the tool names and try again.",
        };
        return { output: result };
      }

      // Fail-closed against direct calls when disclosure is active (knownNames
      // is populated — the immediately preceding above-threshold model call
      // disclosed a tool set):
      //
      // 1. Tool not in the disclosed set at all (guessed / stale / leaked
      //    name) — reject; the model never saw this tool in the current turn
      //    so it has no business calling it.
      // 2. Tool was disclosed at summary level and not promoted — reject;
      //    inputSchema:{} can't validate args, so the call is unsafe.
      // 3. Tool was disclosed and promoted — pass through.
      const state = sessions.get(ctx.session.sessionId);
      if (state !== undefined && state.knownNames.size > 0) {
        if (!state.knownNames.has(request.toolId)) {
          return {
            output: {
              ok: false,
              error: {
                code: "VALIDATION",
                message: `Tool '${request.toolId}' is not in the currently advertised tool set for this session.`,
              },
            },
            metadata: { error: true, toolId: request.toolId, code: "VALIDATION" },
          };
        }
        if (!state.promoted.has(request.toolId)) {
          return {
            output: {
              ok: false,
              error: {
                code: "VALIDATION",
                message: `Tool '${request.toolId}' is at summary level — call ${PROMOTE_TOOL_NAME}(["${request.toolId}"]) first to load its full schema, then retry.`,
              },
            },
            metadata: { error: true, toolId: request.toolId, code: "VALIDATION" },
          };
        }
      }

      return next(request);
    },

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      if (!companionToolRegistered) return undefined;
      const sid: SessionId | undefined = ctx?.session?.sessionId;
      const state = sid !== undefined ? sessions.get(sid) : undefined;
      const count = state?.promoted.size ?? 0;
      return {
        label: "tool-disclosure",
        description: `${count} tools promoted to full descriptor. Use ${PROMOTE_TOOL_NAME} to load full schemas for tools you want to call.`,
      };
    },

    promoteByNameForSession(sid: SessionId, names: readonly string[]): readonly string[] {
      return promoteForSession(sid, names);
    },

    clearCache(): void {
      sessions.clear();
    },

    notifyCompanionRegistered(): void {
      companionToolRegistered = true;
    },
  };

  return middleware;
}

/** Companion tool descriptor for `promote_tools`. */
export function createPromoteToolDescriptor(): ToolDescriptor {
  return {
    name: PROMOTE_TOOL_NAME,
    description:
      "Load full tool schemas for the named tools. Call this before using a tool whose inputSchema is empty (summary-level). Returns the list of successfully promoted tool names.",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Tool names to promote to full descriptor level.",
        },
      },
      required: ["names"],
    },
  };
}
