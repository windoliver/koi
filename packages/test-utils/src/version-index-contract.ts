/**
 * VersionIndex contract test suite.
 *
 * Validates that any VersionIndexBackend implementation satisfies the L0 contract.
 * Usage: import { testVersionIndexContract } from "@koi/test-utils" and call it
 * inside a describe() block with a factory function.
 */

import { describe, expect, test } from "bun:test";
import type { VersionChangeEvent, VersionIndexBackend } from "@koi/core";
import { brickId, publisherId } from "@koi/core";
import { assertKoiError } from "./assert-koi-error.js";
import { assertErr, assertOk } from "./assert-result.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface VersionIndexContractOptions {
  readonly createIndex: () => VersionIndexBackend | Promise<VersionIndexBackend>;
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const TOOL = "tool" as const;
const PUB_ALICE = publisherId("alice");
const PUB_BOB = publisherId("bob");
const BRICK_A = brickId("sha256-aaaa");
const BRICK_B = brickId("sha256-bbbb");
const BRICK_C = brickId("sha256-cccc");

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

/**
 * Runs the VersionIndex contract test suite.
 *
 * Call this inside a `describe()` block. It registers tests that verify
 * the index satisfies all L0 contract invariants.
 */
export function testVersionIndexContract(options: VersionIndexContractOptions): void {
  const { createIndex } = options;

  // -------------------------------------------------------------------------
  // publish()
  // -------------------------------------------------------------------------

  describe("publish()", () => {
    test("publishes and returns entry", async () => {
      const index = await createIndex();
      const result = await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE);
      assertOk(result);
      expect(result.value.version).toBe("1.0.0");
      expect(result.value.brickId).toBe(BRICK_A);
      expect(result.value.publisher).toBe(PUB_ALICE);
      expect(typeof result.value.publishedAt).toBe("number");
      expect(result.value.deprecated).toBeUndefined();
    });

    test("idempotent re-publish with same BrickId", async () => {
      const index = await createIndex();
      const first = await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE);
      assertOk(first);

      const second = await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE);
      assertOk(second);
      expect(second.value.brickId).toBe(BRICK_A);
    });

    test("returns CONFLICT when same label maps to different BrickId", async () => {
      const index = await createIndex();
      assertOk(await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE));

      const conflict = await index.publish("calculator", TOOL, "1.0.0", BRICK_B, PUB_ALICE);
      assertErr(conflict);
      assertKoiError(conflict.error, { code: "CONFLICT" });
    });

    test("returns VALIDATION for empty name", async () => {
      const index = await createIndex();
      const result = await index.publish("", TOOL, "1.0.0", BRICK_A, PUB_ALICE);
      assertErr(result);
      assertKoiError(result.error, { code: "VALIDATION" });
    });

    test("returns VALIDATION for empty version", async () => {
      const index = await createIndex();
      const result = await index.publish("calculator", TOOL, "", BRICK_A, PUB_ALICE);
      assertErr(result);
      assertKoiError(result.error, { code: "VALIDATION" });
    });

    test("returns VALIDATION for whitespace-only name", async () => {
      const index = await createIndex();
      const result = await index.publish("   ", TOOL, "1.0.0", BRICK_A, PUB_ALICE);
      assertErr(result);
      assertKoiError(result.error, { code: "VALIDATION" });
    });

    test("returns VALIDATION for whitespace-only version", async () => {
      const index = await createIndex();
      const result = await index.publish("calculator", TOOL, "  ", BRICK_A, PUB_ALICE);
      assertErr(result);
      assertKoiError(result.error, { code: "VALIDATION" });
    });
  });

  // -------------------------------------------------------------------------
  // resolve()
  // -------------------------------------------------------------------------

  describe("resolve()", () => {
    test("returns correct entry for published version", async () => {
      const index = await createIndex();
      assertOk(await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE));

      const result = await index.resolve("calculator", TOOL, "1.0.0");
      assertOk(result);
      expect(result.value.version).toBe("1.0.0");
      expect(result.value.brickId).toBe(BRICK_A);
      expect(result.value.publisher).toBe(PUB_ALICE);
    });

    test("returns NOT_FOUND for unknown version", async () => {
      const index = await createIndex();
      const result = await index.resolve("calculator", TOOL, "99.0.0");
      assertErr(result);
      assertKoiError(result.error, { code: "NOT_FOUND" });
    });
  });

  // -------------------------------------------------------------------------
  // resolveLatest()
  // -------------------------------------------------------------------------

  describe("resolveLatest()", () => {
    test("returns newest by publishedAt", async () => {
      const index = await createIndex();
      assertOk(await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE));
      assertOk(await index.publish("calculator", TOOL, "2.0.0", BRICK_B, PUB_ALICE));

      const result = await index.resolveLatest("calculator", TOOL);
      assertOk(result);
      expect(result.value.version).toBe("2.0.0");
      expect(result.value.brickId).toBe(BRICK_B);
    });

    test("returns NOT_FOUND when no versions exist", async () => {
      const index = await createIndex();
      const result = await index.resolveLatest("nonexistent", TOOL);
      assertErr(result);
      assertKoiError(result.error, { code: "NOT_FOUND" });
    });

    test("falls back to next-most-recent after latest is yanked", async () => {
      const index = await createIndex();
      assertOk(await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE));
      assertOk(await index.publish("calculator", TOOL, "2.0.0", BRICK_B, PUB_ALICE));

      assertOk(await index.yank("calculator", TOOL, "2.0.0"));

      const result = await index.resolveLatest("calculator", TOOL);
      assertOk(result);
      expect(result.value.version).toBe("1.0.0");
    });
  });

  // -------------------------------------------------------------------------
  // listVersions()
  // -------------------------------------------------------------------------

  describe("listVersions()", () => {
    test("returns versions newest first", async () => {
      const index = await createIndex();
      assertOk(await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE));
      assertOk(await index.publish("calculator", TOOL, "2.0.0", BRICK_B, PUB_ALICE));

      const result = await index.listVersions("calculator", TOOL);
      assertOk(result);
      expect(result.value.length).toBe(2);
      expect(result.value[0]?.version).toBe("2.0.0");
      expect(result.value[1]?.version).toBe("1.0.0");
    });

    test("returns NOT_FOUND for unknown brick", async () => {
      const index = await createIndex();
      const result = await index.listVersions("nonexistent", TOOL);
      assertErr(result);
      assertKoiError(result.error, { code: "NOT_FOUND" });
    });
  });

  // -------------------------------------------------------------------------
  // deprecate()
  // -------------------------------------------------------------------------

  describe("deprecate()", () => {
    test("marks version deprecated (still resolvable)", async () => {
      const index = await createIndex();
      assertOk(await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE));

      const depResult = await index.deprecate("calculator", TOOL, "1.0.0");
      assertOk(depResult);

      // Still resolvable
      const resolved = await index.resolve("calculator", TOOL, "1.0.0");
      assertOk(resolved);
      expect(resolved.value.deprecated).toBe(true);
    });

    test("returns NOT_FOUND for unknown version", async () => {
      const index = await createIndex();
      const result = await index.deprecate("calculator", TOOL, "99.0.0");
      assertErr(result);
      assertKoiError(result.error, { code: "NOT_FOUND" });
    });

    test("deprecating same version twice is idempotent", async () => {
      const index = await createIndex();
      assertOk(await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE));

      assertOk(await index.deprecate("calculator", TOOL, "1.0.0"));
      assertOk(await index.deprecate("calculator", TOOL, "1.0.0"));

      const resolved = await index.resolve("calculator", TOOL, "1.0.0");
      assertOk(resolved);
      expect(resolved.value.deprecated).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // yank()
  // -------------------------------------------------------------------------

  describe("yank()", () => {
    test("removes entry — resolve returns NOT_FOUND after", async () => {
      const index = await createIndex();
      assertOk(await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE));

      const yankResult = await index.yank("calculator", TOOL, "1.0.0");
      assertOk(yankResult);

      const resolved = await index.resolve("calculator", TOOL, "1.0.0");
      assertErr(resolved);
      assertKoiError(resolved.error, { code: "NOT_FOUND" });
    });

    test("returns NOT_FOUND for unknown version", async () => {
      const index = await createIndex();
      const result = await index.yank("calculator", TOOL, "99.0.0");
      assertErr(result);
      assertKoiError(result.error, { code: "NOT_FOUND" });
    });
  });

  // -------------------------------------------------------------------------
  // onChange()
  // -------------------------------------------------------------------------

  describe("onChange()", () => {
    test("returns unsubscribe function", async () => {
      const index = await createIndex();
      if (index.onChange === undefined) return;

      const unsubscribe = index.onChange(() => {});
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
    });

    test("fires on publish", async () => {
      const index = await createIndex();
      if (index.onChange === undefined) return;

      const events: VersionChangeEvent[] = [];
      const unsubscribe = index.onChange((event) => {
        events.push(event);
      });

      assertOk(await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE));
      expect(events.length).toBe(1);
      expect(events[0]?.kind).toBe("published");
      expect(events[0]?.name).toBe("calculator");
      expect(events[0]?.version).toBe("1.0.0");
      expect(events[0]?.brickId).toBe(BRICK_A);
      expect(events[0]?.publisher).toBe(PUB_ALICE);
      unsubscribe();
    });

    test("fires on deprecate", async () => {
      const index = await createIndex();
      if (index.onChange === undefined) return;

      assertOk(await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE));

      const events: VersionChangeEvent[] = [];
      const unsubscribe = index.onChange((event) => {
        events.push(event);
      });

      assertOk(await index.deprecate("calculator", TOOL, "1.0.0"));
      expect(events.length).toBe(1);
      expect(events[0]?.kind).toBe("deprecated");
      unsubscribe();
    });

    test("fires on yank", async () => {
      const index = await createIndex();
      if (index.onChange === undefined) return;

      assertOk(await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE));

      const events: VersionChangeEvent[] = [];
      const unsubscribe = index.onChange((event) => {
        events.push(event);
      });

      assertOk(await index.yank("calculator", TOOL, "1.0.0"));
      expect(events.length).toBe(1);
      expect(events[0]?.kind).toBe("yanked");
      unsubscribe();
    });

    test("unsubscribe stops delivery", async () => {
      const index = await createIndex();
      if (index.onChange === undefined) return;

      const events: VersionChangeEvent[] = [];
      const unsubscribe = index.onChange((event) => {
        events.push(event);
      });

      assertOk(await index.publish("calc", TOOL, "1.0.0", BRICK_A, PUB_ALICE));
      const countAfterFirst = events.length;

      unsubscribe();

      assertOk(await index.publish("calc", TOOL, "2.0.0", BRICK_B, PUB_ALICE));
      expect(events.length).toBe(countAfterFirst);
    });

    test("unsubscribe is idempotent", async () => {
      const index = await createIndex();
      if (index.onChange === undefined) return;

      const unsubscribe = index.onChange(() => {});
      unsubscribe();
      unsubscribe(); // Should not throw
    });
  });

  // -------------------------------------------------------------------------
  // round-trip
  // -------------------------------------------------------------------------

  describe("round-trip", () => {
    test("publish → resolve → listVersions → deprecate → resolve (deprecated flag set)", async () => {
      const index = await createIndex();

      // 1. Publish
      const publishResult = await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE);
      assertOk(publishResult);

      // 2. Resolve
      const resolveResult = await index.resolve("calculator", TOOL, "1.0.0");
      assertOk(resolveResult);
      expect(resolveResult.value.brickId).toBe(BRICK_A);

      // 3. List versions
      const listResult = await index.listVersions("calculator", TOOL);
      assertOk(listResult);
      expect(listResult.value.length).toBe(1);

      // 4. Deprecate
      assertOk(await index.deprecate("calculator", TOOL, "1.0.0"));

      // 5. Resolve still works, deprecated flag set
      const afterDeprecate = await index.resolve("calculator", TOOL, "1.0.0");
      assertOk(afterDeprecate);
      expect(afterDeprecate.value.deprecated).toBe(true);
      expect(afterDeprecate.value.brickId).toBe(BRICK_A);
    });
  });

  // -------------------------------------------------------------------------
  // multi-publisher
  // -------------------------------------------------------------------------

  describe("multi-publisher", () => {
    test("two publishers can publish different versions of the same brick", async () => {
      const index = await createIndex();

      assertOk(await index.publish("calculator", TOOL, "1.0.0", BRICK_A, PUB_ALICE));
      assertOk(await index.publish("calculator", TOOL, "2.0.0", BRICK_C, PUB_BOB));

      const v1 = await index.resolve("calculator", TOOL, "1.0.0");
      assertOk(v1);
      expect(v1.value.publisher).toBe(PUB_ALICE);

      const v2 = await index.resolve("calculator", TOOL, "2.0.0");
      assertOk(v2);
      expect(v2.value.publisher).toBe(PUB_BOB);

      const all = await index.listVersions("calculator", TOOL);
      assertOk(all);
      expect(all.value.length).toBe(2);
    });
  });
}
