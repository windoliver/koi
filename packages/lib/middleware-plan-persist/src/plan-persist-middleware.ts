/**
 * Plan-persist middleware — intercepts koi_plan_save and koi_plan_load
 * tool calls, dispatches to the file backend with the active session id
 * from `TurnContext`.
 *
 * Mirrors the structure of `@koi/middleware-planning`'s plan middleware:
 * the providers register the tools so the engine recognizes the calls
 * as declared, the middleware does the real work in `wrapToolCall`, and
 * the providers' fallback `execute` throws to surface a misconfigured
 * deployment (provider wired without middleware) as a real tool failure.
 */

import type {
  JsonObject,
  KoiMiddleware,
  MiddlewareBundle,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import {
  type ClearJournalResult,
  createPlanPersistBackend,
  type PlanPersistBackend,
  type RestoreJournalResult,
} from "./adapter.js";
import type { PlanPersistConfig } from "./config.js";
import {
  createPlanLoadProvider,
  createPlanSaveProvider,
  PLAN_LOAD_TOOL_NAME,
  PLAN_SAVE_TOOL_NAME,
} from "./tool-providers.js";
import type { OnPlanUpdate, PlanItem } from "./types.js";

/** Default middleware priority. Runs after planning (450), before audit/trace observers. */
const DEFAULT_PRIORITY = 470;

export interface PlanPersistBundle extends MiddlewareBundle {
  /**
   * Wire this into `createPlanMiddleware({ onPlanUpdate })` so every
   * successful `write_plan` is mirrored to disk.
   */
  readonly onPlanUpdate: OnPlanUpdate;
  /** Diagnostic accessor for the in-process plan mirror. */
  readonly getActivePlan: (sessionId: string) => readonly PlanItem[] | undefined;
  /**
   * Restore the active journal for `sessionId` into the in-process
   * mirror. Call at session-start (typically right after the host
   * decides which sessionId to use for the new run) to recover plans
   * across process restarts. Returns a structured result so the host
   * can distinguish "no journal" (safe fresh start) from "I/O failure"
   * or "corrupt journal" (data-loss conditions worth surfacing).
   */
  readonly restoreFromJournal: (sessionId: string) => Promise<RestoreJournalResult>;
  /**
   * Delete the active journal for `sessionId`. Hosts implementing
   * `/clear` or session cycling MUST call this before reusing the same
   * `sessionId` for a logically fresh run, otherwise the previous
   * plan can be silently resurrected by `getActivePlan`, `savePlan`,
   * or (when enabled) auto-restore on session start.
   */
  readonly clearJournal: (sessionId: string) => Promise<ClearJournalResult>;
  /** Absolute path to the resolved plans directory. */
  readonly baseDir: string;
  /** Absolute path to the active-journal directory under baseDir. */
  readonly journalDir: string;
}

export interface PlanPersistMiddlewareConfig extends PlanPersistConfig {
  /** Middleware priority (default: 470). */
  readonly priority?: number | undefined;
}

/**
 * Build the plan-persist middleware bundle. Throws synchronously when
 * `baseDir` cannot resolve to a path under `cwd`.
 */
export function createPlanPersistMiddleware(
  config?: PlanPersistMiddlewareConfig,
): PlanPersistBundle {
  const backend = createPlanPersistBackend(config);
  const priority = config?.priority ?? DEFAULT_PRIORITY;

  const middleware: KoiMiddleware = {
    name: "plan-persist",
    priority,
    // No auto-restore on session start. The journal can repopulate
    // plan-persist's mirror (so `savePlan` works on a recovered plan),
    // but it cannot reach `@koi/middleware-planning`'s in-process
    // `currentPlan` — planning has no public setter, and the model's
    // prompt replay reads from planning's state. Auto-restoring here
    // would silently promise restart-survival of the model's *context*
    // when really only the savePlan path is recovered.
    //
    // Hosts choose how to surface a recovered plan: call
    // `bundle.restoreFromJournal(sessionId)` at startup, then either
    // (a) inject a system message describing the prior plan and
    // letting the model decide what to do, or (b) prompt the model to
    // call `write_plan` with the recovered items so planning's state
    // is reseeded through its own commit path.
    async onSessionEnd(ctx) {
      backend.dropSession(ctx.sessionId as unknown as string);
    },
    describeCapabilities: () => undefined,
    async wrapToolCall(ctx, request, next) {
      if (request.toolId === PLAN_SAVE_TOOL_NAME) {
        return handleSave(backend, ctx.session.sessionId as unknown as string, request);
      }
      if (request.toolId === PLAN_LOAD_TOOL_NAME) {
        return handleLoad(backend, request);
      }
      return next(request);
    },
  };

  const providers = [createPlanSaveProvider(), createPlanLoadProvider()] as const;

  return {
    middleware,
    providers,
    onPlanUpdate: backend.onPlanUpdate,
    getActivePlan: backend.getActivePlan,
    restoreFromJournal: backend.restoreFromJournal,
    clearJournal: backend.clearJournal,
    baseDir: backend.baseDir,
    journalDir: backend.journalDir,
  };
}

async function handleSave(
  backend: PlanPersistBackend,
  sessionId: string,
  request: ToolRequest,
): Promise<ToolResponse> {
  const slugRaw = request.input.slug;
  if (slugRaw !== undefined && typeof slugRaw !== "string") {
    return planError("slug must be a string");
  }
  const slug = typeof slugRaw === "string" ? slugRaw : undefined;
  const result = await backend.savePlan(sessionId, slug);
  if (!result.ok) {
    return planError(result.error);
  }
  return {
    output: {
      path: result.path,
      items: itemsAsJson(result.items),
    } satisfies JsonObject,
    metadata: { persistPath: result.path },
  };
}

async function handleLoad(
  backend: PlanPersistBackend,
  request: ToolRequest,
): Promise<ToolResponse> {
  const pathRaw = request.input.path;
  if (typeof pathRaw !== "string" || pathRaw.length === 0) {
    return planError("path must be a non-empty string");
  }
  const result = await backend.loadPlan(pathRaw);
  if (!result.ok) {
    return planError(result.error);
  }
  return {
    output: {
      path: result.path,
      items: itemsAsJson(result.items),
    } satisfies JsonObject,
    metadata: { planLoadPath: result.path },
  };
}

function planError(message: string): ToolResponse {
  return {
    output: { error: message },
    metadata: { planPersistError: true, reason: message },
  };
}

function itemsAsJson(items: readonly PlanItem[]): JsonObject[] {
  return items.map((item) => ({ content: item.content, status: item.status }));
}
