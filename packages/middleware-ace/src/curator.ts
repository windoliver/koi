/**
 * Curator — converts reflections into delta operations (ADD/MERGE/PRUNE)
 * on structured playbooks. Includes delta application with anti-collapse.
 */

import type { InboundMessage } from "@koi/core/message";
import { computeBulletValue, createBulletId, estimateStructuredTokens } from "./playbook.js";
import type {
  CuratorInput,
  CuratorOperation,
  PlaybookBullet,
  StructuredPlaybook,
} from "./types.js";

/** Adapter interface for the curator agent. */
export interface CuratorAdapter {
  readonly curate: (input: CuratorInput) => Promise<readonly CuratorOperation[]>;
}

/** Model call function signature for LLM-backed curator. */
export type CuratorModelCall = (messages: readonly InboundMessage[]) => Promise<string>;

/** Creates a default LLM-backed curator adapter. */
export function createDefaultCurator(
  modelCall: CuratorModelCall,
  clock: () => number = Date.now,
): CuratorAdapter {
  return {
    async curate(input: CuratorInput): Promise<readonly CuratorOperation[]> {
      const prompt = buildCuratorPrompt(input);
      const message: InboundMessage = {
        senderId: "system:ace:curator",
        timestamp: clock(),
        content: [{ kind: "text", text: prompt }],
      };

      const raw = await modelCall([message]);
      return parseCuratorResponse(raw, input.playbook);
    },
  };
}

/** Mutable section used during delta application. */
interface MutableSection {
  readonly name: string;
  readonly slug: string;
  bullets: PlaybookBullet[];
}

/**
 * Apply delta operations to a structured playbook immutably.
 * Includes anti-collapse: auto-prunes lowest-value bullets when over token budget.
 * Never prunes below 1 bullet per section.
 */
export function applyOperations(
  playbook: StructuredPlaybook,
  ops: readonly CuratorOperation[],
  tokenBudget: number,
  clock: () => number,
  tokenizer?: (text: string) => number,
): StructuredPlaybook {
  const now = clock();
  // let: accumulator that gets rebuilt after each operation
  let sections: MutableSection[] = playbook.sections.map((s) => ({
    ...s,
    bullets: [...s.bullets],
  }));

  const nextIndex = computeNextIndexMap(sections);

  for (const op of ops) {
    switch (op.kind) {
      case "add":
        applyAdd(sections, op, nextIndex, now);
        break;
      case "merge":
        applyMerge(sections, op, nextIndex, now, playbook);
        break;
      case "prune":
        applyPrune(sections, op);
        break;
    }
  }

  sections = enforceTokenBudget(sections, tokenBudget, tokenizer);

  return {
    ...playbook,
    sections: sections.map((s) => ({ ...s, bullets: [...s.bullets] })),
    updatedAt: now,
  };
}

function computeNextIndexMap(sections: readonly MutableSection[]): Map<string, number> {
  const nextIndex = new Map<string, number>();
  for (const section of sections) {
    if (section.bullets.length === 0) {
      nextIndex.set(section.slug, 0);
    } else {
      const maxIdx = section.bullets.reduce((max, b) => {
        const match = b.id.match(/(\d+)\]$/);
        const idx = match?.[1] !== undefined ? parseInt(match[1], 10) : 0;
        return Math.max(max, idx);
      }, 0);
      nextIndex.set(section.slug, maxIdx + 1);
    }
  }
  return nextIndex;
}

function applyAdd(
  sections: MutableSection[],
  op: Extract<CuratorOperation, { readonly kind: "add" }>,
  nextIndex: Map<string, number>,
  now: number,
): void {
  const section = sections.find((s) => s.slug === op.section || s.name === op.section);
  if (section === undefined) return;
  const idx = nextIndex.get(section.slug) ?? 0;
  nextIndex.set(section.slug, idx + 1);
  const bullet: PlaybookBullet = {
    id: createBulletId(section.slug, idx),
    content: op.content,
    helpful: 0,
    harmful: 0,
    createdAt: now,
    updatedAt: now,
  };
  section.bullets = [...section.bullets, bullet];
}

function applyMerge(
  sections: MutableSection[],
  op: Extract<CuratorOperation, { readonly kind: "merge" }>,
  nextIndex: Map<string, number>,
  now: number,
  originalPlaybook: StructuredPlaybook,
): void {
  const [id1, id2] = op.bulletIds;
  // let: searched across sections, may be found in different sections
  let b1: PlaybookBullet | undefined;
  let b2: PlaybookBullet | undefined;
  for (const section of sections) {
    const found1 = section.bullets.find((b) => b.id === id1);
    const found2 = section.bullets.find((b) => b.id === id2);
    if (found1 !== undefined) b1 = found1;
    if (found2 !== undefined) b2 = found2;
  }
  if (b1 === undefined || b2 === undefined) return;

  for (const section of sections) {
    section.bullets = section.bullets.filter((b) => b.id !== id1 && b.id !== id2);
  }

  const targetSection = sections.find(
    (s) => s.slug === findSectionSlugForBullet(originalPlaybook, id1),
  );
  if (targetSection === undefined) return;

  const idx = nextIndex.get(targetSection.slug) ?? 0;
  nextIndex.set(targetSection.slug, idx + 1);
  const merged: PlaybookBullet = {
    id: createBulletId(targetSection.slug, idx),
    content: op.content,
    helpful: b1.helpful + b2.helpful,
    harmful: b1.harmful + b2.harmful,
    createdAt: now,
    updatedAt: now,
  };
  targetSection.bullets = [...targetSection.bullets, merged];
}

function applyPrune(
  sections: MutableSection[],
  op: Extract<CuratorOperation, { readonly kind: "prune" }>,
): void {
  for (const section of sections) {
    if (section.bullets.some((b) => b.id === op.bulletId)) {
      if (section.bullets.length <= 1) return;
      section.bullets = section.bullets.filter((b) => b.id !== op.bulletId);
    }
  }
}

function enforceTokenBudget(
  sections: { readonly name: string; readonly slug: string; bullets: PlaybookBullet[] }[],
  tokenBudget: number,
  tokenizer?: (text: string) => number,
): typeof sections {
  const tempPlaybook: StructuredPlaybook = {
    id: "",
    title: "",
    sections: sections.map((s) => ({ ...s, bullets: s.bullets })),
    tags: [],
    source: "curated",
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 0,
  };

  // let: mutable counter tracking current token usage
  let currentTokens = estimateStructuredTokens(tempPlaybook, tokenizer);

  while (currentTokens > tokenBudget) {
    // Collect all bullets with their section index, excluding sections with only 1 bullet
    const candidates: {
      readonly sectionIdx: number;
      readonly bulletIdx: number;
      readonly value: number;
    }[] = [];
    for (let si = 0; si < sections.length; si++) {
      const section = sections[si];
      if (section === undefined) continue;
      if (section.bullets.length <= 1) continue;
      for (let bi = 0; bi < section.bullets.length; bi++) {
        candidates.push({
          sectionIdx: si,
          bulletIdx: bi,
          value: computeBulletValue(section.bullets[bi] ?? ""),
        });
      }
    }

    if (candidates.length === 0) break;

    // Remove the lowest-value bullet
    const sorted = [...candidates].sort((a, b) => a.value - b.value);
    const lowest = sorted[0];
    if (lowest === undefined) break;
    const section = sections[lowest.sectionIdx];
    if (section === undefined) break;
    section.bullets = section.bullets.filter((_, i) => i !== lowest.bulletIdx);

    // Recalculate tokens
    const updated: StructuredPlaybook = {
      ...tempPlaybook,
      sections: sections.map((s) => ({ ...s, bullets: s.bullets })),
    };
    currentTokens = estimateStructuredTokens(updated, tokenizer);
  }

  return sections;
}

function findSectionSlugForBullet(
  playbook: StructuredPlaybook,
  bulletId: string,
): string | undefined {
  for (const section of playbook.sections) {
    if (section.bullets.some((b) => b.id === bulletId)) {
      return section.slug;
    }
  }
  return undefined;
}

function buildCuratorPrompt(input: CuratorInput): string {
  const { playbook, reflection, tokenBudget } = input;

  const playbookSummary = playbook.sections
    .map((s) => {
      const bullets = s.bullets
        .map((b) => `  ${b.id} (helpful:${b.helpful} harmful:${b.harmful}) ${b.content}`)
        .join("\n");
      return `## ${s.name} (slug: "${s.slug}")\n${bullets}`;
    })
    .join("\n\n");

  return [
    "You are curating a structured playbook based on session reflection.",
    "",
    "Current playbook:",
    playbookSummary,
    "",
    `Root cause: ${reflection.rootCause}`,
    `Key insight: ${reflection.keyInsight}`,
    `Token budget: ${tokenBudget}`,
    "",
    "Produce a JSON array of delta operations:",
    '- { "kind": "add", "section": "<section-slug>", "content": "<new bullet text>" }',
    '- { "kind": "merge", "bulletIds": ["<id1>", "<id2>"], "content": "<merged text>" }',
    '- { "kind": "prune", "bulletId": "<id>" }',
    "",
    "Rules:",
    "- Only add bullets that capture the key insight",
    "- Merge redundant bullets to save tokens",
    "- Prune bullets that are consistently harmful",
    "- Stay within the token budget",
    "",
    "Respond with ONLY the JSON array, no markdown fences.",
  ].join("\n");
}

function parseCuratorResponse(
  raw: string,
  playbook: StructuredPlaybook,
): readonly CuratorOperation[] {
  try {
    const cleaned = raw
      .replace(/^```json?\s*/gm, "")
      .replace(/\s*```\s*$/gm, "")
      .trim();
    const parsed = JSON.parse(cleaned) as unknown;

    if (!Array.isArray(parsed)) return [];

    const validSections = new Set(playbook.sections.map((s) => s.slug));
    for (const s of playbook.sections) {
      validSections.add(s.name);
    }

    const validBulletIds = new Set(playbook.sections.flatMap((s) => s.bullets.map((b) => b.id)));

    const ops: CuratorOperation[] = [];
    for (const item of parsed) {
      const op = validateOperation(item, validSections, validBulletIds);
      if (op !== undefined) ops.push(op);
    }

    return ops;
  } catch {
    return [];
  }
}

/** Normalize a bullet ID: LLMs sometimes strip brackets from `[str-00000]`. */
function normalizeBulletId(id: string, validIds: ReadonlySet<string>): string | undefined {
  if (validIds.has(id)) return id;
  const bracketed = `[${id}]`;
  if (validIds.has(bracketed)) return bracketed;
  return undefined;
}

function validateOperation(
  item: unknown,
  validSections: ReadonlySet<string>,
  validBulletIds: ReadonlySet<string>,
): CuratorOperation | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const obj = item as Record<string, unknown>;

  switch (obj.kind) {
    case "add": {
      if (typeof obj.section !== "string" || typeof obj.content !== "string") return undefined;
      if (!validSections.has(obj.section)) return undefined;
      return { kind: "add", section: obj.section, content: obj.content };
    }
    case "merge": {
      if (!Array.isArray(obj.bulletIds) || obj.bulletIds.length !== 2) return undefined;
      if (typeof obj.content !== "string") return undefined;
      const [rawId1, rawId2] = obj.bulletIds;
      if (typeof rawId1 !== "string" || typeof rawId2 !== "string") return undefined;
      const id1 = normalizeBulletId(rawId1, validBulletIds);
      const id2 = normalizeBulletId(rawId2, validBulletIds);
      if (id1 === undefined || id2 === undefined) return undefined;
      return { kind: "merge", bulletIds: [id1, id2], content: obj.content };
    }
    case "prune": {
      if (typeof obj.bulletId !== "string") return undefined;
      const normalizedId = normalizeBulletId(obj.bulletId, validBulletIds);
      if (normalizedId === undefined) return undefined;
      return { kind: "prune", bulletId: normalizedId };
    }
    default:
      return undefined;
  }
}
