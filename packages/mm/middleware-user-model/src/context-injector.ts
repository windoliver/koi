/**
 * Formats the [User Context] block with sub-budgets for preferences,
 * sensor state, and meta (ambiguity/question).
 */

import type { UserSnapshot } from "@koi/core/user-model";
import { estimateTokens } from "@koi/token-estimator";

export interface ContextBudget {
  readonly maxPreferenceTokens: number;
  readonly maxSensorTokens: number;
  readonly maxMetaTokens: number;
}

/**
 * Caps an array of text entries by cumulative token budget.
 * Returns entries that fit within the budget.
 */
function capByTokenBudget(entries: readonly string[], maxTokens: number): readonly string[] {
  const capped: string[] = [];
  let tokensUsed = 0; // let: accumulator for token budget

  for (const entry of entries) {
    const tokens = estimateTokens(entry);
    if (tokensUsed + tokens > maxTokens) break;
    tokensUsed += tokens;
    capped.push(entry);
  }

  return capped;
}

function formatSensorState(state: Readonly<Record<string, unknown>>, maxTokens: number): string {
  const keys = Object.keys(state);
  if (keys.length === 0) return "";

  const lines: string[] = [];
  let tokensUsed = 0; // let: accumulator for token budget

  for (const key of keys) {
    const line = `${key}: ${JSON.stringify(state[key])}`;
    const tokens = estimateTokens(line);
    if (tokensUsed + tokens > maxTokens) break;
    tokensUsed += tokens;
    lines.push(line);
  }

  return lines.length > 0 ? `Sensor State:\n${lines.join("\n")}` : "";
}

/**
 * Formats a UserSnapshot into a single [User Context] text block.
 * Returns undefined if all sections are empty (nothing to inject).
 */
export function formatUserContext(
  snapshot: UserSnapshot,
  budget: ContextBudget,
): string | undefined {
  const sections: string[] = [];

  // Preferences section
  if (snapshot.preferences.length > 0) {
    const prefTexts = snapshot.preferences.map((p) => p.content);
    const capped = capByTokenBudget(prefTexts, budget.maxPreferenceTokens);
    if (capped.length > 0) {
      sections.push(`Preferences:\n${capped.join("\n")}`);
    }
  }

  // Sensor state section
  if (Object.keys(snapshot.state).length > 0) {
    const sensorText = formatSensorState(snapshot.state, budget.maxSensorTokens);
    if (sensorText.length > 0) {
      sections.push(sensorText);
    }
  }

  // Meta section (ambiguity/question)
  if (snapshot.ambiguityDetected && snapshot.suggestedQuestion !== undefined) {
    const metaText = `Clarification Needed: ${snapshot.suggestedQuestion}`;
    const tokens = estimateTokens(metaText);
    if (tokens <= budget.maxMetaTokens) {
      sections.push(metaText);
    }
  }

  if (sections.length === 0) return undefined;

  return `[User Context]\n${sections.join("\n\n")}`;
}
