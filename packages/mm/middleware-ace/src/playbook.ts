/**
 * Structured playbook operations — ID generation, serialization,
 * citation extraction, counter ops, and token estimation.
 */

import { estimateTokens } from "@koi/token-estimator";
import type { PlaybookBullet, PlaybookSection, StructuredPlaybook } from "./types.js";

const BULLET_ID_PATTERN = /\[([a-z]+-\d{5})\]/g;

/** Generate a bracketed bullet ID: `[slug-NNNNN]`. */
export function createBulletId(sectionSlug: string, index: number): string {
  return `[${sectionSlug}-${String(index).padStart(5, "0")}]`;
}

/** Compute net value: helpful minus harmful. */
export function computeBulletValue(bullet: PlaybookBullet): number {
  return bullet.helpful - bullet.harmful;
}

/** Return a new bullet with the specified counter incremented by 1. */
export function incrementCounter(
  bullet: PlaybookBullet,
  tag: "helpful" | "harmful",
): PlaybookBullet {
  return {
    ...bullet,
    [tag]: bullet[tag] + 1,
  };
}

/** Serialize a structured playbook for injection into model context. */
export function serializeForInjection(playbook: StructuredPlaybook): string {
  if (playbook.sections.length === 0) return "";

  return playbook.sections
    .map((section) => {
      const header = `## ${section.name}`;
      const lines = section.bullets.map((b) => `${b.id} ${b.content}`);
      return [header, ...lines].join("\n");
    })
    .join("\n\n");
}

/** Extract deduplicated cited bullet IDs from text. */
export function extractCitedBulletIds(text: string): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const match of text.matchAll(BULLET_ID_PATTERN)) {
    const id = `[${match[1]}]`;
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }

  return result;
}

/**
 * Estimate token count for a structured playbook.
 * Includes structural overhead (headers, IDs, newlines).
 *
 * Accepts sync or async tokenizers — remote estimators return Promise\<number\>.
 */
export function estimateStructuredTokens(
  playbook: StructuredPlaybook,
  tokenizer?: (text: string) => number | Promise<number>,
): number | Promise<number> {
  if (playbook.sections.length === 0) return 0;

  const text = serializeForInjection(playbook);
  return tokenizer !== undefined ? tokenizer(text) : estimateTokens(text);
}

/** Create an empty structured playbook with named sections. */
export function createEmptyPlaybook(
  id: string,
  title: string,
  sectionNames: readonly string[],
  clock?: () => number,
): StructuredPlaybook {
  const now = clock !== undefined ? clock() : Date.now();
  const sections: readonly PlaybookSection[] = sectionNames.map((name) => ({
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    bullets: [],
  }));

  return {
    id,
    title,
    sections,
    tags: [],
    source: "curated",
    createdAt: now,
    updatedAt: now,
    sessionCount: 0,
  };
}
