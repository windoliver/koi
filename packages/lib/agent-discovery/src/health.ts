import type { ExternalAgentDescriptor } from "@koi/core";
import { DEFAULT_HEALTH_TIMEOUT_MS } from "./constants.js";
import type { SystemCalls } from "./types.js";

export interface HealthResult {
  readonly status: "healthy" | "unhealthy" | "unknown";
  readonly latencyMs: number;
  readonly message?: string;
}

export async function checkAgentHealth(
  agent: ExternalAgentDescriptor,
  sc: SystemCalls,
  timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS,
): Promise<HealthResult> {
  if (agent.transport !== "cli" || !agent.command) {
    return { status: "unknown", latencyMs: 0 };
  }
  const start = performance.now();
  try {
    const { exitCode } = await sc.spawn([agent.command, "--version"], timeoutMs);
    return {
      status: exitCode === 0 ? "healthy" : "unhealthy",
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (e: unknown) {
    return {
      status: "unhealthy",
      latencyMs: Math.round(performance.now() - start),
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
