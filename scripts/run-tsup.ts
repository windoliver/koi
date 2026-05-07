#!/usr/bin/env bun
/**
 * Run the workspace tsup binary through Bun explicitly.
 *
 * Turborepo invokes package scripts from each workspace package. With Bun's
 * isolated linker, invoking the bare `tsup` bin through Turbo can run through a
 * Node resolution path that loses tsup/Rollup's native optional dependencies on
 * macOS. Executing the root bin via Bun keeps dependency resolution aligned
 * with the direct `bun run build` path.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tsupBin = new URL("../node_modules/.bin/tsup", import.meta.url);
const args = [fileURLToPath(tsupBin), ...process.argv.slice(2)];

const result = spawnSync(process.execPath, args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    KOI_REPO_ROOT: root,
  },
  stdio: "inherit",
});

if (result.error !== undefined) {
  throw result.error;
}

process.exit(result.status ?? 1);
