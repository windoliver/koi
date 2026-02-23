import { describe, expect, test } from "bun:test";
import type { BacktrackReason } from "@koi/core";
import { BACKTRACK_REASON_KEY } from "@koi/core";
import { attachBacktrackReason, extractBacktrackReason } from "./backtrack-helper.js";

describe("attachBacktrackReason", () => {
  const reason: BacktrackReason = {
    kind: "validation_failure",
    message: "Schema mismatch",
    timestamp: 1700000000000,
  };

  test("returns new object with reason attached", () => {
    const metadata = { existing: "value" };
    const result = attachBacktrackReason(metadata, reason);

    expect(result[BACKTRACK_REASON_KEY]).toEqual(reason);
    expect(result.existing).toBe("value");
  });

  test("does not mutate original metadata", () => {
    const metadata: Record<string, unknown> = { existing: "value" };
    attachBacktrackReason(metadata, reason);

    expect(metadata[BACKTRACK_REASON_KEY]).toBeUndefined();
  });
});

describe("extractBacktrackReason", () => {
  const reason: BacktrackReason = {
    kind: "timeout",
    message: "Model call timed out",
    timestamp: 1700000000000,
  };

  test("extracts valid reason", () => {
    const metadata = { [BACKTRACK_REASON_KEY]: reason };
    const extracted = extractBacktrackReason(metadata);

    expect(extracted).toEqual(reason);
  });

  test("returns undefined for missing key", () => {
    const metadata = { other: "data" };
    const extracted = extractBacktrackReason(metadata);

    expect(extracted).toBeUndefined();
  });

  test("returns undefined for invalid value", () => {
    const metadata = { [BACKTRACK_REASON_KEY]: "not-an-object" };
    const extracted = extractBacktrackReason(metadata);

    expect(extracted).toBeUndefined();
  });

  test("returns undefined for object missing required fields", () => {
    const metadata = { [BACKTRACK_REASON_KEY]: { kind: "timeout" } };
    const extracted = extractBacktrackReason(metadata);

    expect(extracted).toBeUndefined();
  });

  test("round-trip: attach then extract", () => {
    const metadata = { existing: "value" };
    const attached = attachBacktrackReason(metadata, reason);
    const extracted = extractBacktrackReason(attached);

    expect(extracted).toEqual(reason);
  });
});
