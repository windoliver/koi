/**
 * Reflector — analyzes session trajectory to produce root cause analysis
 * and bullet credit assignment for structured playbooks.
 */

import type { InboundMessage } from "@koi/core/message";
import type { ReflectionResult, ReflectorInput } from "./types.js";

/** Adapter interface for the reflector agent. */
export interface ReflectorAdapter {
  readonly analyze: (input: ReflectorInput) => Promise<ReflectionResult>;
}

/** Model call function signature for LLM-backed reflector. */
export type ReflectorModelCall = (messages: readonly InboundMessage[]) => Promise<string>;

/** Creates a default LLM-backed reflector adapter. */
export function createDefaultReflector(
  modelCall: ReflectorModelCall,
  clock: () => number = Date.now,
): ReflectorAdapter {
  return {
    async analyze(input: ReflectorInput): Promise<ReflectionResult> {
      const systemPrompt = buildReflectorPrompt(input);
      const message: InboundMessage = {
        senderId: "system:ace:reflector",
        timestamp: clock(),
        content: [{ kind: "text", text: systemPrompt }],
      };

      const raw = await modelCall([message]);
      return parseReflectionResponse(raw, input.citedBulletIds);
    },
  };
}

const MAX_TRAJECTORY_ENTRIES = 10;

function buildReflectorPrompt(input: ReflectorInput): string {
  const trajectorySlice = input.trajectory
    .slice(-MAX_TRAJECTORY_ENTRIES)
    .map((e) => `- [${e.kind}] ${e.identifier}: ${e.outcome} (${e.durationMs}ms)`)
    .join("\n");

  const citedSection =
    input.citedBulletIds.length > 0 ? `\nCited bullet IDs: ${input.citedBulletIds.join(", ")}` : "";

  return [
    "You are analyzing an agent session trajectory to identify patterns.",
    `Overall outcome: ${input.outcome}`,
    "",
    "Recent actions:",
    trajectorySlice,
    citedSection,
    "",
    "Respond with a JSON object containing:",
    '- "rootCause": A single sentence explaining the root cause of the outcome.',
    '- "keyInsight": A single actionable insight for future sessions.',
    '- "bulletTags": An array of { "id": "<bullet-id>", "tag": "helpful" | "harmful" | "neutral" } for each cited bullet ID.',
    "",
    "Respond with ONLY the JSON object, no markdown fences.",
  ].join("\n");
}

function parseReflectionResponse(raw: string, citedBulletIds: readonly string[]): ReflectionResult {
  try {
    const cleaned = raw.replace(/^```json?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const rootCause = typeof parsed.rootCause === "string" ? parsed.rootCause : "";
    const keyInsight = typeof parsed.keyInsight === "string" ? parsed.keyInsight : "";
    const bulletTags = parseBulletTags(parsed.bulletTags, citedBulletIds);

    return { rootCause, keyInsight, bulletTags };
  } catch {
    return { rootCause: "", keyInsight: "", bulletTags: [] };
  }
}

function isBulletTagLike(item: unknown): item is { readonly id: string; readonly tag: string } {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  return typeof obj.id === "string" && typeof obj.tag === "string";
}

/** Normalize a bullet ID: LLMs sometimes strip brackets from `[str-00000]`. */
function normalizeBulletId(id: string, validIds: ReadonlySet<string>): string | undefined {
  if (validIds.has(id)) return id;
  // Try adding brackets: "str-00000" → "[str-00000]"
  const bracketed = `[${id}]`;
  if (validIds.has(bracketed)) return bracketed;
  return undefined;
}

function parseBulletTags(
  raw: unknown,
  validIds: readonly string[],
): ReflectionResult["bulletTags"] {
  if (!Array.isArray(raw)) return [];

  const validIdSet = new Set(validIds);
  const result: { readonly id: string; readonly tag: "helpful" | "harmful" | "neutral" }[] = [];

  for (const item of raw) {
    if (isBulletTagLike(item)) {
      const normalized = normalizeBulletId(item.id, validIdSet);
      if (
        normalized !== undefined &&
        (item.tag === "helpful" || item.tag === "harmful" || item.tag === "neutral")
      ) {
        result.push({ id: normalized, tag: item.tag });
      }
    }
  }

  return result;
}
