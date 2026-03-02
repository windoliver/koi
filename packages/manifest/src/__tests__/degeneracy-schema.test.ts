import { describe, expect, test } from "bun:test";
import { rawManifestSchema } from "../schema.js";

/** Minimal valid manifest base — extend with field under test. */
const BASE = {
  name: "my-agent",
  version: "1.0.0",
  model: "anthropic:claude-sonnet-4-5-20250929",
} as const;

function parse(extra: Record<string, unknown> = {}): {
  success: boolean;
  data?: unknown;
  error?: unknown;
} {
  return rawManifestSchema.safeParse({ ...BASE, ...extra });
}

describe("rawManifestSchema — degeneracy", () => {
  test("accepts valid degeneracy config", () => {
    const result = parse({
      degeneracy: {
        search: {
          selectionStrategy: "fitness",
          minVariants: 2,
          maxVariants: 3,
          failoverEnabled: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("applies defaults when fields are omitted", () => {
    const result = parse({
      degeneracy: {
        search: {},
      },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data !== undefined) {
      const data = result.data as { readonly degeneracy: Record<string, Record<string, unknown>> };
      const search = data.degeneracy.search;
      expect(search?.selectionStrategy).toBe("fitness");
      expect(search?.minVariants).toBe(1);
      expect(search?.maxVariants).toBe(3);
      expect(search?.failoverEnabled).toBe(true);
    }
  });

  test("rejects minVariants > maxVariants", () => {
    const result = parse({
      degeneracy: {
        search: {
          minVariants: 5,
          maxVariants: 2,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects minVariants < 1", () => {
    const result = parse({
      degeneracy: {
        search: {
          minVariants: 0,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects maxVariants < 1", () => {
    const result = parse({
      degeneracy: {
        search: {
          maxVariants: 0,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid strategy", () => {
    const result = parse({
      degeneracy: {
        search: {
          selectionStrategy: "invalid-strategy",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-boolean failoverEnabled", () => {
    const result = parse({
      degeneracy: {
        search: {
          failoverEnabled: "yes",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("accepts manifest without degeneracy block", () => {
    const result = parse();
    expect(result.success).toBe(true);
  });

  test("accepts multiple capability configs", () => {
    const result = parse({
      degeneracy: {
        search: {
          selectionStrategy: "fitness",
          minVariants: 2,
          maxVariants: 3,
          failoverEnabled: true,
        },
        translate: {
          selectionStrategy: "round-robin",
          minVariants: 1,
          maxVariants: 2,
          failoverEnabled: false,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
