import { describe, expect, test } from "bun:test";
import {
  computeBulletValue,
  createBulletId,
  createEmptyPlaybook,
  estimateStructuredTokens,
  extractCitedBulletIds,
  incrementCounter,
  serializeForInjection,
} from "./playbook.js";
import type { PlaybookBullet, PlaybookSection, StructuredPlaybook } from "./types.js";

function makeBullet(overrides?: Partial<PlaybookBullet>): PlaybookBullet {
  return {
    id: "[str-00001]",
    content: "Always validate inputs",
    helpful: 3,
    harmful: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeSection(overrides?: Partial<PlaybookSection>): PlaybookSection {
  return {
    name: "Strategy",
    slug: "str",
    bullets: [makeBullet()],
    ...overrides,
  };
}

function makePlaybook(overrides?: Partial<StructuredPlaybook>): StructuredPlaybook {
  return {
    id: "pb-1",
    title: "Test Playbook",
    sections: [makeSection()],
    tags: ["tool_call"],
    source: "curated",
    createdAt: 1000,
    updatedAt: 1000,
    sessionCount: 1,
    ...overrides,
  };
}

describe("createBulletId", () => {
  test("formats bullet ID with zero-padded index", () => {
    expect(createBulletId("str", 1)).toBe("[str-00001]");
    expect(createBulletId("err", 42)).toBe("[err-00042]");
    expect(createBulletId("tool", 0)).toBe("[tool-00000]");
  });

  test("handles large indices", () => {
    expect(createBulletId("str", 99999)).toBe("[str-99999]");
  });
});

describe("computeBulletValue", () => {
  test("returns helpful minus harmful", () => {
    expect(computeBulletValue(makeBullet({ helpful: 5, harmful: 2 }))).toBe(3);
  });

  test("returns negative when harmful exceeds helpful", () => {
    expect(computeBulletValue(makeBullet({ helpful: 1, harmful: 4 }))).toBe(-3);
  });

  test("returns zero when equal", () => {
    expect(computeBulletValue(makeBullet({ helpful: 3, harmful: 3 }))).toBe(0);
  });

  test("returns zero for zeroed counters", () => {
    expect(computeBulletValue(makeBullet({ helpful: 0, harmful: 0 }))).toBe(0);
  });
});

describe("incrementCounter", () => {
  test("increments helpful counter immutably", () => {
    const bullet = makeBullet({ helpful: 3, harmful: 1 });
    const updated = incrementCounter(bullet, "helpful");
    expect(updated.helpful).toBe(4);
    expect(updated.harmful).toBe(1);
    // Original not mutated
    expect(bullet.helpful).toBe(3);
  });

  test("increments harmful counter immutably", () => {
    const bullet = makeBullet({ helpful: 3, harmful: 1 });
    const updated = incrementCounter(bullet, "harmful");
    expect(updated.harmful).toBe(2);
    expect(updated.helpful).toBe(3);
    expect(bullet.harmful).toBe(1);
  });

  test("preserves other fields", () => {
    const bullet = makeBullet({ id: "[err-00005]", content: "Handle errors" });
    const updated = incrementCounter(bullet, "helpful");
    expect(updated.id).toBe("[err-00005]");
    expect(updated.content).toBe("Handle errors");
    expect(updated.createdAt).toBe(bullet.createdAt);
  });
});

describe("serializeForInjection", () => {
  test("produces section headers and bullet lines", () => {
    const playbook = makePlaybook({
      sections: [
        makeSection({
          name: "Strategy",
          slug: "str",
          bullets: [
            makeBullet({ id: "[str-00001]", content: "Use caching" }),
            makeBullet({ id: "[str-00002]", content: "Retry on failure" }),
          ],
        }),
        makeSection({
          name: "Error Handling",
          slug: "err",
          bullets: [makeBullet({ id: "[err-00001]", content: "Log with context" })],
        }),
      ],
    });

    const result = serializeForInjection(playbook);
    expect(result).toContain("## Strategy");
    expect(result).toContain("[str-00001] Use caching");
    expect(result).toContain("[str-00002] Retry on failure");
    expect(result).toContain("## Error Handling");
    expect(result).toContain("[err-00001] Log with context");
  });

  test("empty sections produce header only", () => {
    const playbook = makePlaybook({
      sections: [makeSection({ name: "Empty", slug: "emp", bullets: [] })],
    });
    const result = serializeForInjection(playbook);
    expect(result).toContain("## Empty");
  });

  test("empty playbook produces empty string", () => {
    const playbook = makePlaybook({ sections: [] });
    const result = serializeForInjection(playbook);
    expect(result).toBe("");
  });
});

describe("extractCitedBulletIds", () => {
  test("extracts single citation", () => {
    const ids = extractCitedBulletIds("As per [str-00001], we should cache.");
    expect(ids).toEqual(["[str-00001]"]);
  });

  test("extracts multiple citations", () => {
    const ids = extractCitedBulletIds("Per [str-00001] and [err-00002], handle errors.");
    expect(ids).toEqual(["[str-00001]", "[err-00002]"]);
  });

  test("returns empty array for no citations", () => {
    const ids = extractCitedBulletIds("No citations here.");
    expect(ids).toEqual([]);
  });

  test("deduplicates repeated citations", () => {
    const ids = extractCitedBulletIds("[str-00001] appears twice [str-00001]");
    expect(ids).toEqual(["[str-00001]"]);
  });

  test("handles malformed brackets", () => {
    const ids = extractCitedBulletIds("[not-valid] and [123] and []");
    expect(ids).toEqual([]);
  });

  test("extracts from code blocks", () => {
    const ids = extractCitedBulletIds("```\n[str-00001] in code\n```");
    expect(ids).toEqual(["[str-00001]"]);
  });
});

describe("estimateStructuredTokens", () => {
  test("includes structural overhead for sections and bullets", () => {
    const playbook = makePlaybook({
      sections: [
        makeSection({
          bullets: [
            makeBullet({ content: "x".repeat(100) }),
            makeBullet({ content: "y".repeat(100) }),
          ],
        }),
      ],
    });

    const tokens = estimateStructuredTokens(playbook);
    // Should be more than just raw content length / 4 due to headers, IDs, newlines
    const rawContentChars = 200;
    expect(tokens).toBeGreaterThan(Math.ceil(rawContentChars / 4));
  });

  test("returns 0 for empty playbook", () => {
    const playbook = makePlaybook({ sections: [] });
    expect(estimateStructuredTokens(playbook)).toBe(0);
  });

  test("uses custom tokenizer when provided", () => {
    const playbook = makePlaybook();
    const customTokenizer = (text: string): number => text.length; // 1 char = 1 token
    const tokens = estimateStructuredTokens(playbook, customTokenizer);
    const defaultTokens = estimateStructuredTokens(playbook);
    // Custom tokenizer should give a different result than default
    expect(tokens).not.toBe(defaultTokens);
  });
});

describe("createEmptyPlaybook", () => {
  test("creates playbook with named sections and no bullets", () => {
    const pb = createEmptyPlaybook("pb-new", "New Playbook", ["Strategy", "Errors", "Tools"]);
    expect(pb.id).toBe("pb-new");
    expect(pb.title).toBe("New Playbook");
    expect(pb.sections).toHaveLength(3);
    expect(pb.sections[0]?.name).toBe("Strategy");
    expect(pb.sections[0]?.slug).toBe("strategy");
    expect(pb.sections[0]?.bullets).toEqual([]);
    expect(pb.sections[1]?.slug).toBe("errors");
    expect(pb.sections[2]?.slug).toBe("tools");
    expect(pb.source).toBe("curated");
    expect(pb.sessionCount).toBe(0);
  });

  test("uses provided clock for timestamps", () => {
    const pb = createEmptyPlaybook("pb-1", "Title", ["A"], () => 5000);
    expect(pb.createdAt).toBe(5000);
    expect(pb.updatedAt).toBe(5000);
  });
});

describe("roundtrip: serialize → extract IDs", () => {
  test("extracted IDs match original bullet IDs", () => {
    const playbook = makePlaybook({
      sections: [
        makeSection({
          bullets: [
            makeBullet({ id: "[str-00001]", content: "Cache reads" }),
            makeBullet({ id: "[str-00002]", content: "Validate inputs" }),
          ],
        }),
        makeSection({
          name: "Errors",
          slug: "err",
          bullets: [makeBullet({ id: "[err-00001]", content: "Log context" })],
        }),
      ],
    });

    const serialized = serializeForInjection(playbook);
    const extractedIds = extractCitedBulletIds(serialized);

    expect(extractedIds).toContain("[str-00001]");
    expect(extractedIds).toContain("[str-00002]");
    expect(extractedIds).toContain("[err-00001]");
    expect(extractedIds).toHaveLength(3);
  });
});
