/**
 * Registry exhaustiveness and command module shape tests (Decision 9-A).
 *
 * Tests that:
 *   1. COMMAND_LOADERS has an entry for every KnownCommand (exhaustiveness)
 *   2. Each loader resolves to a module with a callable `run` export (shape)
 *
 * This replaces the untestable "only the dispatched module is imported" spec.
 * The JS module system handles lazy loading — these tests verify the registry
 * is wired correctly, which is the invariant users and bin.ts depend on.
 */

import { describe, expect, test } from "bun:test";
import { COMMAND_NAMES } from "./args.js";
import { COMMAND_LOADERS } from "./registry.js";

describe("COMMAND_LOADERS", () => {
  test("has a loader for every KnownCommand", () => {
    for (const name of COMMAND_NAMES) {
      expect(COMMAND_LOADERS[name]).toBeTypeOf("function");
    }
  });

  test("no extra keys beyond KnownCommand", () => {
    const registryKeys = new Set(Object.keys(COMMAND_LOADERS));
    const knownKeys = new Set(COMMAND_NAMES);
    for (const key of registryKeys) {
      expect(knownKeys.has(key as never)).toBe(true);
    }
    expect(registryKeys.size).toBe(knownKeys.size);
  });

  test("each loader resolves to a module with a callable run export", async () => {
    for (const name of COMMAND_NAMES) {
      const loader = COMMAND_LOADERS[name];
      const mod = await loader();
      expect(mod).toBeDefined();
      expect(mod.run).toBeTypeOf("function");
    }
  });
});
