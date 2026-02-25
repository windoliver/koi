/**
 * Forge-specific repair strategy — enriches retry context with tool source,
 * test cases, health metrics, and a computed suggestion.
 */

import type { ForgeStore } from "@koi/core";
import { brickId as toBrickId } from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { formatErrors } from "./repair.js";
import type { ToolHealthTracker } from "./tool-health.js";
import type { RepairStrategy, ValidationError } from "./types.js";

/** Configuration for forge-aware repair strategy. */
export interface ForgeRepairConfig {
  readonly forgeStore: ForgeStore;
  readonly healthTracker: ToolHealthTracker;
  readonly resolveBrickId: (toolId: string) => string | undefined;
}

function computeSuggestion(errorRate: number, failureCount: number, hasTestCases: boolean): string {
  const parts: string[] = [];
  if (errorRate > 0.75) {
    parts.push("This tool is critically unreliable.");
  } else if (errorRate > 0.5) {
    parts.push("This tool has a high failure rate.");
  }
  if (failureCount > 3) {
    parts.push(`It has failed ${failureCount} times recently.`);
  }
  if (hasTestCases) {
    parts.push("Review the test cases below and fix the implementation to pass them.");
  } else {
    parts.push("Consider adding test cases to validate the fix.");
  }
  return parts.join(" ");
}

/**
 * Creates a forge-aware repair strategy that enriches retry requests
 * with tool source code, test cases, and health context.
 *
 * Falls back to default error formatting when brickId resolution fails
 * or when the forge store load errors.
 */
export function createForgeRepairStrategy(config: ForgeRepairConfig): RepairStrategy {
  const { forgeStore, healthTracker, resolveBrickId } = config;

  return {
    async buildRetryRequest(
      original: ModelRequest,
      response: ModelResponse,
      errors: readonly ValidationError[],
      attempt: number,
    ): Promise<ModelRequest> {
      // Extract toolId from the first validation error's validator field or fallback
      const toolId = errors[0]?.path ?? errors[0]?.validator ?? "";
      const brickId = resolveBrickId(toolId);

      // Default feedback (always included)
      const baseErrorText = formatErrors(errors);

      // Attempt forge enrichment
      const enrichmentParts: string[] = [];

      if (brickId !== undefined) {
        const loadResult = await forgeStore.load(toBrickId(brickId));
        if (loadResult.ok && loadResult.value.kind === "tool") {
          const artifact = loadResult.value;
          enrichmentParts.push(
            `## Tool Source (${artifact.name})\n\`\`\`\n${artifact.implementation}\n\`\`\``,
          );

          if (artifact.testCases !== undefined && artifact.testCases.length > 0) {
            const testSummary = artifact.testCases
              .map((tc) => `- ${tc.name}: input=${JSON.stringify(tc.input)}`)
              .join("\n");
            enrichmentParts.push(`## Test Cases\n${testSummary}`);
          }
        }

        const snapshot = healthTracker.getSnapshot(toolId);
        if (snapshot !== undefined) {
          const { metrics, recentFailures } = snapshot;
          enrichmentParts.push(
            `## Health Metrics\n- Error rate: ${(metrics.errorRate * 100).toFixed(0)}%\n- Usage count: ${metrics.usageCount}\n- Avg latency: ${metrics.avgLatencyMs.toFixed(0)}ms`,
          );

          if (recentFailures.length > 0) {
            const failureLines = recentFailures.map((f) => `- ${f.error}`).join("\n");
            enrichmentParts.push(`## Recent Failures\n${failureLines}`);
          }

          const suggestion = computeSuggestion(
            metrics.errorRate,
            recentFailures.length,
            enrichmentParts.some((p) => p.startsWith("## Test Cases")),
          );
          enrichmentParts.push(`## Suggestion\n${suggestion}`);
        }
      }

      const assistantMessage: InboundMessage = {
        senderId: "assistant",
        timestamp: Date.now(),
        content: [{ kind: "text", text: response.content }],
      };

      const feedbackText =
        enrichmentParts.length > 0
          ? `Your previous response had validation errors (attempt ${attempt}). Please fix them:\n\n${baseErrorText}\n\n---\n\n${enrichmentParts.join("\n\n")}`
          : `Your previous response had validation errors (attempt ${attempt}). Please fix them and try again:\n\n${baseErrorText}`;

      const errorMessage: InboundMessage = {
        senderId: "system:feedback-loop",
        timestamp: Date.now(),
        content: [{ kind: "text", text: feedbackText }],
      };

      return {
        ...original,
        messages: [...original.messages, assistantMessage, errorMessage],
      };
    },
  };
}
