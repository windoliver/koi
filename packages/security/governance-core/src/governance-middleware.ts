import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { createAlertTracker } from "./alert-tracker.js";
import type { GovernanceMiddlewareConfig } from "./config.js";
import { DEFAULT_ALERT_THRESHOLDS } from "./config.js";

export const GOVERNANCE_MIDDLEWARE_NAME = "koi:governance-core";
export const GOVERNANCE_MIDDLEWARE_PRIORITY = 150;

export function createGovernanceMiddleware(config: GovernanceMiddlewareConfig): KoiMiddleware {
  const { controller, onAlert } = config;
  // biome-ignore lint/correctness/noUnusedVariables: wired in Task 6
  const { backend, cost, onViolation, onUsage } = config;
  const alertTracker = createAlertTracker({
    thresholds: config.alertThresholds ?? DEFAULT_ALERT_THRESHOLDS,
  });

  return {
    name: GOVERNANCE_MIDDLEWARE_NAME,
    priority: GOVERNANCE_MIDDLEWARE_PRIORITY,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment {
      return {
        label: "governance",
        description: "Policy gate + setpoint enforcement active",
      };
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const snap = await controller.snapshot();
      alertTracker.checkAndFire(ctx.session.sessionId, snap, onAlert);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      alertTracker.cleanup(ctx.sessionId);
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      return next(request);
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<never> {
      yield* next(request) as AsyncIterable<never>;
    },

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      return next(request);
    },
  };
}
