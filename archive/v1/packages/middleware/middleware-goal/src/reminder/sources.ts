/**
 * Resolve all reminder sources into a single XML-tagged reminder block.
 */

import type { TurnContext } from "@koi/core/middleware";
import type { ReminderSource } from "./types.js";

/**
 * Resolve all sources in parallel and combine into a `<reminder>` block.
 *
 * Each source kind maps to a tagged section:
 * - manifest → `<goals>...</goals>`
 * - static → `<context>...</context>`
 * - dynamic → `<context>...</context>`
 * - tasks → `<tasks>...</tasks>`
 *
 * User-supplied async sources (dynamic fetch, tasks provider) are fail-safe:
 * if they throw, a placeholder is emitted instead of crashing the agent turn.
 */
export async function resolveAllSources(
  sources: readonly ReminderSource[],
  ctx: TurnContext,
): Promise<string> {
  const resolved = await Promise.all(sources.map((s) => resolveSource(s, ctx)));
  const nonEmpty = resolved.filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return "";
  return `<reminder>\n${nonEmpty.join("\n")}\n</reminder>`;
}

async function resolveSource(source: ReminderSource, ctx: TurnContext): Promise<string> {
  switch (source.kind) {
    case "manifest": {
      if (source.objectives.length === 0) return "";
      const items = source.objectives.map((o) => `- ${o}`).join("\n");
      return `<goals>\n${items}\n</goals>`;
    }
    case "static":
      return `<context>\n${source.text}\n</context>`;
    case "dynamic": {
      try {
        const text = await source.fetch(ctx);
        return `<context>\n${text}\n</context>`;
      } catch (_e: unknown) {
        return "<context>[dynamic source unavailable]</context>";
      }
    }
    case "tasks": {
      try {
        const tasks = await source.provider(ctx);
        if (tasks.length === 0) return "";
        const items = tasks.map((t) => `- ${t}`).join("\n");
        return `<tasks>\n${items}\n</tasks>`;
      } catch (_e: unknown) {
        return "<tasks>[task source unavailable]</tasks>";
      }
    }
  }
}
