#!/usr/bin/env bun

/**
 * Root entry point for the tool-safety E2E test.
 *
 * The implementation lives in packages/meta/runtime/scripts/ because Bun's
 * isolated linker resolves @koi/* workspace packages relative to the script's
 * location, and the runtime package is the only one with all the L2 deps
 * (event-trace, hooks, permissions, model-openai-compat, tool-error-formatter,
 * tools-core, query-engine, skills-runtime) wired up.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-... bun run scripts/test-tool-safety-e2e.ts
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const implPath = join(repoRoot, "packages/meta/runtime/scripts/test-tool-safety-e2e-impl.ts");

const proc = Bun.spawn(["bun", implPath], {
  cwd: join(repoRoot, "packages/meta/runtime"),
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env },
});
const exitCode = await proc.exited;
process.exit(exitCode);
