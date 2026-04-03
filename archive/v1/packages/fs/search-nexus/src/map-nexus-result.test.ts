import { describe, expect, it } from "bun:test";
import { mapNexusResult } from "./map-nexus-result.js";
import type { NexusSearchHit } from "./nexus-types.js";

describe("mapNexusResult", () => {
  it("maps a minimal hit to SearchResult", () => {
    const hit: NexusSearchHit = {
      path: "src/main.ts",
      chunk_text: "function main() {}",
      chunk_index: 0,
      score: 0.95,
    };

    const result = mapNexusResult(hit);

    expect(result).toEqual({
      id: "src/main.ts:0",
      score: 0.95,
      content: "function main() {}",
      source: "nexus",
      metadata: { path: "src/main.ts" },
    });
  });

  it("maps a hit with all optional fields", () => {
    const hit: NexusSearchHit = {
      path: "src/utils.ts",
      chunk_text: "export const add = (a, b) => a + b;",
      chunk_index: 3,
      score: 0.82,
      line_start: 10,
      line_end: 15,
      keyword_score: 0.6,
      vector_score: 0.9,
    };

    const result = mapNexusResult(hit);

    expect(result).toEqual({
      id: "src/utils.ts:3",
      score: 0.82,
      content: "export const add = (a, b) => a + b;",
      source: "nexus",
      metadata: {
        path: "src/utils.ts",
        lineStart: 10,
        lineEnd: 15,
        keywordScore: 0.6,
        vectorScore: 0.9,
      },
    });
  });

  it("omits optional metadata when not present", () => {
    const hit: NexusSearchHit = {
      path: "a.ts",
      chunk_text: "x",
      chunk_index: 0,
      score: 0.5,
    };

    const result = mapNexusResult(hit);

    expect(result.metadata).toEqual({ path: "a.ts" });
    expect("lineStart" in result.metadata).toBe(false);
    expect("lineEnd" in result.metadata).toBe(false);
  });
});
