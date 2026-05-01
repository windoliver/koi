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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

  test("each loader resolves to a module with a callable run export", () => {
    const cliRoot = fileURLToPath(new URL("..", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const { COMMAND_NAMES } = await import("./src/args.ts");
          const { COMMAND_LOADERS } = await import("./src/registry.ts");
          for (const name of COMMAND_NAMES) {
            const mod = await COMMAND_LOADERS[name]();
            if (typeof mod?.run !== "function") {
              console.error(\`\${name}: expected callable run export\`);
              process.exit(1);
            }
          }
          process.exit(0);
        `,
      ],
      { cwd: cliRoot, encoding: "utf8", timeout: 45_000 },
    );

    if (result.status !== 0) {
      throw new Error(
        [
          `command-loader shape probe failed with status ${String(result.status)}`,
          result.error?.message,
          result.stdout,
          result.stderr,
        ]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .join("\n"),
      );
    }
  }, 60_000);
});
