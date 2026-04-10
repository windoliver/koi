/**
 * API surface smoke test — verifies that every public export is reachable
 * from the package entry point.
 *
 * A snapshot-based dts test is intentionally avoided here because this
 * package contains tests that are typechecked without a prior build in CI.
 * Runtime presence + typecheck are sufficient to catch accidental
 * export removals.
 */

import { describe, expect, test } from "bun:test";
import * as api from "../index.js";

const EXPECTED_EXPORTS: readonly string[] = [
  // mock adapter
  "createMockAdapter",
  "textResponse",
  "streamTextChunks",
  // fake engine
  "createFakeEngine",
  // mock channel
  "createMockChannel",
  // mock tool
  "createMockTool",
  // handler spies
  "createSpyModelHandler",
  "createSpyModelStreamHandler",
  "createSpyToolHandler",
  // contexts / message
  "createMockSessionContext",
  "createMockTurnContext",
  "createMockInboundMessage",
  // collectors
  "collectEvents",
  "collectOutput",
  "collectText",
  "collectToolNames",
  "collectUsage",
  "filterByKind",
  // assertions
  "assertCostUnder",
  "assertNoToolErrors",
  "assertTextContains",
  "assertTextMatches",
  "assertToolSequence",
  "assertTurnCount",
  // result assertions
  "assertErr",
  "assertErrCode",
  "assertOk",
];

describe("@koi/test API surface", () => {
  for (const name of EXPECTED_EXPORTS) {
    test(`exports ${name}`, () => {
      expect((api as Record<string, unknown>)[name]).toBeDefined();
    });
  }

  test("no unexpected extras (guards against silent additions)", () => {
    const actual = new Set(Object.keys(api));
    const expected = new Set(EXPECTED_EXPORTS);
    const extras = [...actual].filter((k) => !expected.has(k));
    expect(extras).toEqual([]);
  });
});
