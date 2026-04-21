import type { CollectiveMemoryCategory, CollectiveMemoryEntry } from "@koi/core";
import { selectEntriesWithinBudget } from "@koi/validation";

function escapeCollectiveMemoryTags(text: string): string {
  return text
    .replaceAll("</koi:collective-memory>", "&lt;/koi:collective-memory&gt;")
    .replaceAll("<koi:collective-memory>", "&lt;koi:collective-memory&gt;");
}

const CATEGORY_LABELS = {
  gotcha: "Gotchas",
  heuristic: "Heuristics",
  preference: "Preferences",
  correction: "Corrections",
  pattern: "Patterns",
  context: "Context",
} as const satisfies Record<CollectiveMemoryCategory, string>;

const CATEGORY_ORDER: readonly CollectiveMemoryCategory[] = [
  "gotcha",
  "correction",
  "pattern",
  "heuristic",
  "preference",
  "context",
];

export function formatCollectiveMemory(
  entries: readonly CollectiveMemoryEntry[],
  budget: number,
  charsPerToken = 4,
): string {
  if (entries.length === 0 || budget <= 0) return "";

  const selected = selectEntriesWithinBudget(entries, budget, charsPerToken);
  if (selected.length === 0) return "";

  const groups = new Map<CollectiveMemoryCategory, readonly CollectiveMemoryEntry[]>();
  for (const entry of selected) {
    const existing = groups.get(entry.category) ?? [];
    groups.set(entry.category, [...existing, entry]);
  }

  const sections: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const groupEntries = groups.get(category);
    if (groupEntries === undefined || groupEntries.length === 0) continue;
    const label = CATEGORY_LABELS[category];
    // Escape wrapper boundary tokens so entries cannot break out of the injected block.
    const items = groupEntries.map((e) => `- ${escapeCollectiveMemoryTags(e.content)}`).join("\n");
    sections.push(`### ${label}\n${items}`);
  }

  if (sections.length === 0) return "";
  // Wrap in boundary tags so the model treats this as retrieved context, not instructions.
  const body = `## Collective Memory\n\n${sections.join("\n\n")}`;
  return `<koi:collective-memory>\n${body}\n</koi:collective-memory>`;
}
