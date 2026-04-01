/**
 * Reflector — analyzes session trajectory to produce root cause analysis
 * and bullet credit assignment for structured playbooks.
 */

import type { InboundMessage } from "@koi/core/message";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import { normalizeBulletId } from "./playbook.js";
import type { ReflectionResult, ReflectorInput } from "./types.js";

/** Callback for LLM response parse failures. */
export type ParseFailureCallback = (
  raw: string,
  error: unknown,
  stage: "reflector" | "curator",
) => void;

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
  onParseFailure?: ParseFailureCallback,
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
      return parseReflectionResponse(raw, input.citedBulletIds, onParseFailure);
    },
  };
}

const MAX_TRAJECTORY_ENTRIES = 10;

function buildReflectorPrompt(input: ReflectorInput): string {
  // Prefer rich trajectory when available; fall back to compact entries
  const trajectorySection =
    input.richTrajectory !== undefined && input.richTrajectory.length > 0
      ? formatRichTrajectory(input.richTrajectory)
      : formatCompactTrajectory(input.trajectory);

  const citedSection =
    input.citedBulletIds.length > 0
      ? `\nPlaybook bullet IDs cited by the agent: ${input.citedBulletIds.join(", ")}`
      : "";

  const playbookSection =
    input.playbook.sections.flatMap((s) => s.bullets).length > 0
      ? "\nCurrent playbook bullets:\n" +
        input.playbook.sections
          .flatMap((s) =>
            s.bullets.map(
              (b) =>
                `  ${b.id} (helpful=${String(b.helpful)} harmful=${String(b.harmful)}): ${b.content}`,
            ),
          )
          .join("\n")
      : "";

  const isSuccess = input.outcome === "success";

  return [
    "You are an expert analyst diagnosing an AI agent's performance during a task session.",
    "",
    isSuccess
      ? "**The session was SUCCESSFUL.** Your primary job is to TAG existing playbook bullets as helpful, harmful, or neutral based on this trajectory. Only generate a new key_insight if the agent discovered a genuinely novel technique not already in the playbook."
      : "**The session had FAILURES.** Your job is to diagnose what went wrong, identify the root cause, and suggest what the agent should do differently next time.",
    "",
    "**Important context about the agent's environment:**",
    "- The agent uses tools (fs_read, fs_write, fs_list, etc.) to interact with the filesystem",
    "- Some middleware runs AUTOMATICALLY and is NOT the agent's choice:",
    "  - rlm-virtualize: auto-virtualizes large tool outputs (agent must call rlm_examine to read them)",
    "  - compactor: auto-compresses old context when token limit is reached",
    "  - permissions: auto-blocks unauthorized tool calls",
    "  - governance: auto-evaluates policy rules",
    "- Focus your analysis on AGENT DECISIONS (which tools to call, in what order, how to handle errors)",
    "- Do NOT recommend middleware behavior — the agent cannot control it",
    "",
    `Overall session outcome: ${input.outcome}`,
    "",
    "Agent's execution trace:",
    trajectorySection,
    citedSection,
    playbookSection,
    "",
    "**Respond with a JSON object containing these fields:**",
    "",
    '- "reasoning": Your detailed chain-of-thought analysis of the trajectory (2-3 sentences)',
    '- "error_identification": What specifically went wrong, or "none" if successful',
    '- "root_cause_analysis": WHY the error occurred, or "session was successful" if no errors',
    '- "correct_approach": What the agent should have done differently, or "no changes needed" if successful',
    '- "key_insight": One actionable NEW strategy NOT already in the playbook. Set to "" (empty) if the session was successful and the playbook already covers this pattern',
    '- "bulletTags": Array of { "id": "<bullet-id>", "tag": "helpful" | "harmful" | "neutral" } for each cited playbook bullet',
    "",
    "**Guidelines:**",
    "- Be SPECIFIC: name exact tools, files, and error messages",
    "- Be ACTIONABLE: the insight must be something the agent can actually do differently",
    "- Do NOT suggest middleware changes — focus on agent-level tool usage and strategy",
    "- If the session was fully successful with no issues, focus on what made it efficient",
    "",
    "Respond with ONLY the JSON object, no markdown fences.",
  ].join("\n");
}

function formatCompactTrajectory(
  entries: readonly {
    readonly kind: string;
    readonly identifier: string;
    readonly outcome: string;
    readonly durationMs: number;
  }[],
): string {
  return entries
    .slice(-MAX_TRAJECTORY_ENTRIES)
    .map((e) => `- [${e.kind}] ${e.identifier}: ${e.outcome} (${e.durationMs}ms)`)
    .join("\n");
}

/** Format rich trajectory steps for the reflector prompt with full context.
 *  No slice applied here — the caller (compressRichTrajectory) already
 *  selected the highest-priority steps within the token budget. */
export function formatRichTrajectory(steps: readonly RichTrajectoryStep[]): string {
  return steps
    .map((step) => {
      const parts: string[] = [
        `- [${step.kind}] ${step.identifier}: ${step.outcome} (${step.durationMs}ms)`,
      ];

      if (step.request?.text !== undefined) {
        const truncated = step.request.truncated === true ? " [truncated]" : "";
        parts.push(`  Request: ${step.request.text}${truncated}`);
      }

      if (step.reasoningContent !== undefined) {
        parts.push(`  Reasoning: ${step.reasoningContent}`);
      }

      if (step.response?.text !== undefined) {
        const truncated = step.response.truncated === true ? " [truncated]" : "";
        parts.push(`  Response: ${step.response.text}${truncated}`);
      }

      if (step.error?.text !== undefined) {
        parts.push(`  Error: ${step.error.text}`);
      }

      return parts.join("\n");
    })
    .join("\n");
}

function parseReflectionResponse(
  raw: string,
  citedBulletIds: readonly string[],
  onParseFailure?: ParseFailureCallback,
): ReflectionResult {
  try {
    const cleaned = raw.replace(/^```json?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    // Support both old format (rootCause) and new format (root_cause_analysis)
    const rootCause =
      typeof parsed.root_cause_analysis === "string"
        ? parsed.root_cause_analysis
        : typeof parsed.rootCause === "string"
          ? parsed.rootCause
          : "";
    const keyInsight =
      typeof parsed.key_insight === "string"
        ? parsed.key_insight
        : typeof parsed.keyInsight === "string"
          ? parsed.keyInsight
          : "";
    const bulletTags = parseBulletTags(parsed.bulletTags ?? parsed.bullet_tags, citedBulletIds);

    return { rootCause, keyInsight, bulletTags };
  } catch (e: unknown) {
    onParseFailure?.(raw, e, "reflector");
    throw new Error("ACE reflector: failed to parse LLM response", { cause: e });
  }
}

function isBulletTagLike(item: unknown): item is { readonly id: string; readonly tag: string } {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  return typeof obj.id === "string" && typeof obj.tag === "string";
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
