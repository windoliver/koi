/**
 * @koi/middleware-planning — Structured multi-step task tracking (Layer 2)
 *
 * Injects a `write_plan` tool that lets agents create and maintain
 * structured plans across conversation turns.
 */

export { validatePlanConfig } from "./config.js";
export { descriptor } from "./descriptor.js";
export { createPlanMiddleware } from "./plan-middleware.js";
export { PLAN_SYSTEM_PROMPT, WRITE_PLAN_DESCRIPTOR, WRITE_PLAN_TOOL_NAME } from "./plan-tool.js";
export type { PlanConfig, PlanItem, PlanStatus } from "./types.js";
