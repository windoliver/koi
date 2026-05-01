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
 * `onSessionEnd`. The companion tool (registered via the bundle factory)
 * targets the session whose model call most recently passed through
 * `wrapModelCall`; this matches the engine's serial per-session execution
 * model. Truly concurrent multi-session use of one middleware instance is not
 * supported — instantiate one middleware per runtime.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  SessionId,
  ToolDescriptor,
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
   * Promote tools by name within the most recently active session. Adds names
   * to the session's promoted set if they exist in the latest input descriptor
   * list. Returns the names actually promoted. Used by the `promote_tools`
   * companion tool, which has no SessionId in scope.
   */
  readonly promoteByName: (names: readonly string[]) => readonly string[];
  /**
   * Promote tools by name for an explicit session. Use this when you have a
   * SessionId in hand (e.g., from a custom dispatcher). Returns the names
   * actually promoted; an empty array if the session is unknown.
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

function summarize(tool: ToolDescriptor): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {},
    ...(tool.tags !== undefined && tool.tags.length > 0 ? { tags: tool.tags } : {}),
  };
}

export function createToolDisclosureMiddleware(
  config?: ToolDisclosureConfig,
): ToolDisclosureMiddleware {
  const threshold = config?.threshold ?? DEFAULT_DISCLOSURE_THRESHOLD;

  // Per-session state map. Populated on session start, torn down on session end.
  // let justified: mutable map keyed by SessionId.
  const sessions = new Map<SessionId, SessionState>();

  // Most recently active session — used by the companion tool's promoteByName,
  // which has no SessionId in its execute() scope. Updated by wrapModelCall.
  // let justified: mutable ref tracking last-touched session.
  let activeSessionId: SessionId | undefined;

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
      if (activeSessionId === ctx.sessionId) activeSessionId = undefined;
    },

    wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      activeSessionId = ctx.session.sessionId;
      if (request.tools === undefined || request.tools.length <= threshold) {
        return next(request);
      }
      const state = getOrCreate(ctx.session.sessionId);
      const disclosed = disclose(state, request.tools);
      return next({ ...request, tools: disclosed });
    },

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      if (!companionToolRegistered) return undefined;
      const sid: SessionId | undefined = ctx?.session?.sessionId ?? activeSessionId;
      const state = sid !== undefined ? sessions.get(sid) : undefined;
      const count = state?.promoted.size ?? 0;
      return {
        label: "tool-disclosure",
        description: `${count} tools promoted to full descriptor. Use ${PROMOTE_TOOL_NAME} to load full schemas for tools you want to call.`,
      };
    },

    promoteByName(names: readonly string[]): readonly string[] {
      if (activeSessionId === undefined) return [];
      return promoteForSession(activeSessionId, names);
    },

    promoteByNameForSession(sid: SessionId, names: readonly string[]): readonly string[] {
      return promoteForSession(sid, names);
    },

    clearCache(): void {
      sessions.clear();
      activeSessionId = undefined;
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
