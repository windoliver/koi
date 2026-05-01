/**
 * Action execution — runs resolved actions with graceful degradation.
 *
 * Each action is wrapped in try/catch. Errors are logged but never propagated.
 * Missing dependencies degrade to logging.
 */

import { interpolate } from "./interpolate.js";
import type { ActionContext, RawAction, ResolvedAction, RuleLogger } from "./types.js";

/**
 * Maximum time an auxiliary action handler may run before the action
 * is abandoned. Auxiliary actions (emit/notify/escalate) run inline on
 * the tool-call critical path; without a bound, a slow or hung
 * notification/escalation backend would stall every matched tool call
 * and turn an alerting outage into a user-visible runtime outage.
 * 5 seconds is generous enough for a healthy backend round-trip but
 * short enough to keep tool-call latency observable when alerting is
 * degraded.
 */
const ACTION_HANDLER_TIMEOUT_MS = 5_000;

/**
 * Runs `fn` with a bounded timeout AND an AbortController. The signal
 * is provided to `fn` so handlers that honor it (fetch, AbortSignal-
 * aware HTTP clients) can cancel in-flight work on timeout — JS cannot
 * forcibly cancel a Promise, but opt-in cancellation prevents orphaned
 * sockets and resource accumulation when alerting backends hang.
 *
 * Errors are caught and logged; nothing throws past this helper.
 */
export async function runBounded(
  fn: (signal: AbortSignal) => Promise<void>,
  ruleName: string,
  actionType: string,
  logger: RuleLogger,
): Promise<void> {
  const controller = new AbortController();
  // let justified: timer handle captured for cleanup
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(controller.signal),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`action handler exceeded ${ACTION_HANDLER_TIMEOUT_MS}ms`));
          reject(new Error(`action handler exceeded ${ACTION_HANDLER_TIMEOUT_MS}ms`));
        }, ACTION_HANDLER_TIMEOUT_MS);
      }),
    ]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`Action '${actionType}' from rule '${ruleName}' failed: ${msg}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const CONSOLE_LOGGER: RuleLogger = {
  info: (msg) => console.info(`[event-rules] ${msg}`),
  warn: (msg) => console.warn(`[event-rules] ${msg}`),
  error: (msg) => console.error(`[event-rules] ${msg}`),
  debug: (msg) => console.debug(`[event-rules] ${msg}`),
};

async function executeEmit(
  action: RawAction,
  message: string,
  ctx: ActionContext,
  logger: RuleLogger,
  signal: AbortSignal,
): Promise<void> {
  const event = action.event ?? "";
  if (ctx.emitEvent !== undefined) {
    await ctx.emitEvent(event, { message }, signal);
  } else {
    logger.info(`[emit degraded] event=${event} message=${message}`);
  }
}

async function executeEscalate(
  message: string,
  ctx: ActionContext,
  logger: RuleLogger,
  signal: AbortSignal,
): Promise<void> {
  if (ctx.requestEscalation !== undefined) {
    await ctx.requestEscalation(message, signal);
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
  signal: AbortSignal,
): Promise<void> {
  const channel = action.channel ?? "";
  if (ctx.sendNotification !== undefined) {
    await ctx.sendNotification(channel, message, signal);
  } else {
    logger.warn(`[notify degraded] channel=${channel} message=${message}`);
  }
}

export async function executeActions(
  resolvedActions: readonly ResolvedAction[],
  eventContext: Readonly<Record<string, unknown>>,
  actionContext: ActionContext,
): Promise<void> {
  const logger = actionContext.logger ?? CONSOLE_LOGGER;

  for (const { ruleName, action, extraContext } of resolvedActions) {
    try {
      // Prefer the engine-built `extraContext` (safe core fields +
      // threshold metadata) when present — that path explicitly omits
      // unsanitized tool-input fields so log/notify/emit/escalate
      // messages cannot exfiltrate secrets that happen to live in tool
      // arguments. Direct callers (engine-test harnesses) that don't
      // populate `extraContext` fall back to `eventContext`; the rule
      // engine itself always populates `extraContext`, so production
      // rule firings never reach that fallback.
      const renderContext: Readonly<Record<string, unknown>> = extraContext ?? eventContext;
      const message =
        action.message !== undefined ? interpolate(action.message, renderContext) : "";

      switch (action.type) {
        case "emit":
          await runBounded(
            (signal) => executeEmit(action, message, actionContext, logger, signal),
            ruleName,
            "emit",
            logger,
          );
          break;
        case "escalate":
          await runBounded(
            (signal) => executeEscalate(message, actionContext, logger, signal),
            ruleName,
            "escalate",
            logger,
          );
          break;
        case "log":
          executeLog(action, message, logger);
          break;
        case "notify":
          await runBounded(
            (signal) => executeNotify(action, message, actionContext, logger, signal),
            ruleName,
            "notify",
            logger,
          );
          break;
        case "skip_tool":
          // skip_tool is handled by caller via skipToolIds — no execution
          break;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`Action '${action.type}' from rule '${ruleName}' failed: ${msg}`);
    }
  }
}
