/**
 * Action execution — runs resolved actions with graceful degradation.
 *
 * Each action is wrapped in try/catch. Errors are logged but never propagated.
 * Missing dependencies degrade to logging.
 */

import { interpolate } from "./interpolate.js";
import type { ActionContext, RawAction, ResolvedAction, RuleLogger } from "./types.js";

// ---------------------------------------------------------------------------
// Console fallback logger
// ---------------------------------------------------------------------------

const CONSOLE_LOGGER: RuleLogger = {
  info: (msg) => console.info(`[event-rules] ${msg}`),
  warn: (msg) => console.warn(`[event-rules] ${msg}`),
  error: (msg) => console.error(`[event-rules] ${msg}`),
  debug: (msg) => console.debug(`[event-rules] ${msg}`),
};

// ---------------------------------------------------------------------------
// Per-action executors
// ---------------------------------------------------------------------------

async function executeEmit(
  action: RawAction,
  message: string,
  ctx: ActionContext,
  logger: RuleLogger,
): Promise<void> {
  const event = action.event ?? "";
  if (ctx.emitEvent !== undefined) {
    await ctx.emitEvent(event, { message });
  } else {
    logger.info(`[emit degraded] event=${event} message=${message}`);
  }
}

async function executeEscalate(
  message: string,
  ctx: ActionContext,
  logger: RuleLogger,
): Promise<void> {
  if (ctx.requestEscalation !== undefined) {
    await ctx.requestEscalation(message);
  } else {
    logger.error(`[escalate degraded] ${message}`);
  }
}

function executeLog(action: RawAction, message: string, logger: RuleLogger): void {
  const level = action.level ?? "info";
  logger[level](message);
}

async function executeNotify(
  action: RawAction,
  message: string,
  ctx: ActionContext,
  logger: RuleLogger,
): Promise<void> {
  const channel = action.channel ?? "";
  if (ctx.sendNotification !== undefined) {
    await ctx.sendNotification(channel, message);
  } else {
    logger.warn(`[notify degraded] channel=${channel} message=${message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes resolved actions with template interpolation and graceful degradation.
 *
 * @param resolvedActions - Actions matched by the rule engine.
 * @param eventContext - Context for template interpolation (event fields + extras).
 * @param actionContext - Injected dependencies for action execution.
 */
export async function executeActions(
  resolvedActions: readonly ResolvedAction[],
  eventContext: Readonly<Record<string, unknown>>,
  actionContext: ActionContext,
): Promise<void> {
  const logger = actionContext.logger ?? CONSOLE_LOGGER;

  for (const { ruleName, action } of resolvedActions) {
    try {
      const message = action.message !== undefined ? interpolate(action.message, eventContext) : "";

      switch (action.type) {
        case "emit":
          await executeEmit(action, message, actionContext, logger);
          break;
        case "escalate":
          await executeEscalate(message, actionContext, logger);
          break;
        case "log":
          executeLog(action, message, logger);
          break;
        case "notify":
          await executeNotify(action, message, actionContext, logger);
          break;
        case "skip_tool":
          // skip_tool is handled by the caller via skipToolIds — no action to execute
          break;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`Action '${action.type}' from rule '${ruleName}' failed: ${msg}`);
    }
  }
}
