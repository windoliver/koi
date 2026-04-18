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
import { createPlanPersistBackend, type PlanPersistBackend } from "./adapter.js";
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
  /** Absolute path to the resolved plans directory. */
  readonly baseDir: string;
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
    baseDir: backend.baseDir,
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
