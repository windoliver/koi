/**
 * Health check — validates external agent availability.
 *
 * Two-tier design:
 * - CLI: spawn with --version, check exit code (fast presence check)
 * - MCP/A2A: return "unknown" (deep check not implemented in v1)
 */

import type { ExternalAgentDescriptor } from "@koi/core";
import { DEFAULT_HEALTH_TIMEOUT_MS } from "./constants.js";
import type { HealthCheckResult, SystemCalls } from "./types.js";

/**
 * Check the health of an external agent.
 *
 * For CLI agents: spawns the command with --version and checks exit code.
 * For MCP/A2A agents: returns "unknown" — deep checks deferred to v2.
 */
export async function checkAgentHealth(
  agent: ExternalAgentDescriptor,
  systemCalls: SystemCalls,
  timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS,
): Promise<HealthCheckResult> {
  if (agent.transport !== "cli" || agent.command === undefined) {
    return {
      status: "unknown",
      latencyMs: 0,
      message: "Health check not supported for this transport",
    };
  }

  const start = performance.now();
  try {
    const result = await systemCalls.exec(agent.command, ["--version"], timeoutMs);
    const latencyMs = Math.round(performance.now() - start);

    if (result.exitCode === 0) {
      return { status: "healthy", latencyMs, message: result.stdout };
    }
    return { status: "unhealthy", latencyMs, message: `Exit code: ${String(result.exitCode)}` };
  } catch (e: unknown) {
    const latencyMs = Math.round(performance.now() - start);
    const message = e instanceof Error ? e.message : "Unknown error";
    return { status: "unhealthy", latencyMs, message };
  }
}
