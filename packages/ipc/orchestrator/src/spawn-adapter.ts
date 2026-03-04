/**
 * Spawn adapter — maps unified SpawnFn to SpawnWorkerFn + upstream context formatting.
 *
 * Bridges the L0 unified spawn interface (Decision 5B) with
 * the orchestrator package-specific SpawnWorkerFn signature.
 */

import type { SpawnFn, TaskResult } from "@koi/core";
import { agentId as brandAgentId } from "@koi/core";
import type { SpawnWorkerFn, SpawnWorkerRequest, SpawnWorkerResult } from "./types.js";
import { DEFAULT_ORCHESTRATOR_CONFIG } from "./types.js";

/**
 * Formats upstream task results into a context block for downstream workers.
 *
 * Each upstream result is rendered as a structured section. Output text is
 * truncated to `maxCharsPerResult` to prevent context blow-up.
 */
export function formatUpstreamContext(
  results: readonly TaskResult[],
  maxCharsPerResult: number,
): string {
  if (results.length === 0) return "";

  const sections: string[] = [];
  for (const r of results) {
    const lines: string[] = [`[Upstream: ${r.taskId}]`];

    const output =
      r.output.length > maxCharsPerResult
        ? `${r.output.slice(0, maxCharsPerResult)}... (truncated)`
        : r.output;
    lines.push(`Output: ${output}`);

    if (r.artifacts !== undefined && r.artifacts.length > 0) {
      const artList = r.artifacts.map((a) => `${a.kind}:${a.uri}`).join(", ");
      lines.push(`Artifacts: ${artList}`);
    }

    if (r.warnings !== undefined && r.warnings.length > 0) {
      lines.push(`Warnings: ${r.warnings.join("; ")}`);
    }

    sections.push(lines.join("\n"));
  }

  return `--- Upstream Context ---\n${sections.join("\n\n")}\n--- End Upstream Context ---`;
}

/**
 * Adapt a unified SpawnFn into a SpawnWorkerFn.
 *
 * Maps SpawnWorkerRequest → SpawnRequest (adds taskId, agentId) and
 * SpawnResult → SpawnWorkerResult (KoiError passes through directly).
 * When upstream results are present, prepends formatted context to the description.
 */
export function mapSpawnToWorker(
  spawn: SpawnFn,
  agentName: string,
  maxUpstreamContextPerTask?: number,
): SpawnWorkerFn {
  const maxChars =
    maxUpstreamContextPerTask ?? DEFAULT_ORCHESTRATOR_CONFIG.maxUpstreamContextPerTask;

  return async (request: SpawnWorkerRequest): Promise<SpawnWorkerResult> => {
    const upstream = request.upstreamResults;
    const contextBlock =
      upstream !== undefined && upstream.length > 0
        ? formatUpstreamContext(upstream, maxChars)
        : "";
    const description =
      contextBlock.length > 0 ? `${contextBlock}\n\n${request.description}` : request.description;

    const result = await spawn({
      description,
      agentName,
      signal: request.signal,
      taskId: request.taskId,
      agentId: request.agentId !== undefined ? brandAgentId(request.agentId) : undefined,
    });

    return result;
  };
}
