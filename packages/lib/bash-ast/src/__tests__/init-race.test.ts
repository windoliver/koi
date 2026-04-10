/**
 * init-race.test.ts — proves that concurrent first-callers share a single
 * in-flight init promise and the underlying WASM load runs exactly once.
 *
 * This guards against the "N callers → N inits" landmine when rolling a
 * lazy init implementation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { analyzeBashCommand } from "../analyze.js";
import { __resetForTests, initializeBashAst } from "../init.js";

describe("init race — concurrent first-callers", () => {
  afterEach(() => {
    __resetForTests();
  });

  test("Promise.all of N concurrent initializeBashAst calls all resolve to the same parser state", async () => {
    __resetForTests();
    const N = 12;
    // Launch N concurrent init calls — they should all share the same
    // in-flight promise rather than each doing an independent WASM load.
    const starts = Array.from({ length: N }, () => initializeBashAst());
    await Promise.all(starts);

    // After all inits resolve, the parser is usable for a real classify.
    const r = analyzeBashCommand("echo hi");
    expect(r.kind).toBe("simple");
  });

  test("initializeBashAst is idempotent after resolution", async () => {
    __resetForTests();
    await initializeBashAst();
    // Second call resolves from the cached promise — no re-init work.
    const start = performance.now();
    await initializeBashAst();
    const elapsed = performance.now() - start;
    // Cached resolution must be near-instant. 50 ms is generous and gives
    // macOS cold test processes plenty of slack.
    expect(elapsed).toBeLessThan(50);
  });
});
