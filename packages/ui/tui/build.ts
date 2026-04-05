/**
 * Build script for @koi/tui.
 *
 * Uses Bun.build with @opentui/solid/bun-plugin so that .tsx files containing
 * Solid JSX are compiled correctly via Babel + babel-preset-solid. Plain tsup
 * uses esbuild which does not understand Solid's reactive JSX transform.
 *
 * Type declarations (.d.ts) are emitted separately by `tsc --emitDeclarationOnly`
 * since Bun.build does not produce TypeScript declarations.
 *
 * Run via: bun run build.ts
 */

import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const OUTDIR = "dist";
const ENTRIES = [
  "src/index.ts",
  "src/state/index.ts",
  "src/bridge/permission-bridge.ts",
  "src/commands/slash-detection.ts",
  "src/components/index.ts",
  "src/batcher/event-batcher.ts",
  "src/worker/engine-channel.ts",
];

// Clean dist + tsbuildinfo so tsc incremental cache doesn't skip declaration emit
rmSync(OUTDIR, { recursive: true, force: true });
rmSync("tsconfig.tsbuildinfo", { force: true });
mkdirSync(OUTDIR, { recursive: true });

// 1. Build JS — Solid plugin transforms .tsx files via Babel.
//
// All singleton-sensitive runtime dependencies are externalized so:
//   a) solid-js, @opentui/* share one instance across all subpath exports
//   b) StoreContext / TuiStateContext are not duplicated per entry
//   c) The emitted files are small, library-style modules (not app bundles)
//
// target: "bun" is correct — @koi/tui is a private workspace package consumed
// only inside the Koi monorepo, which mandates Bun (see CLAUDE.md).
const result = await Bun.build({
  entrypoints: ENTRIES,
  outdir: OUTDIR,
  format: "esm",
  target: "bun",
  splitting: true, // shared chunks prevent duplicated solid-js context singletons
  external: [
    "solid-js",
    "solid-js/*",
    "@opentui/core",
    "@opentui/solid",
    "@koi/core",
    "@koi/core/*",
  ],
  plugins: [createSolidTransformPlugin({ moduleName: "@opentui/solid" })],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`✓ JS built: ${result.outputs.length} files → ${OUTDIR}/`);

// 2. Emit .d.ts declarations via tsc
execSync("tsc --noEmit false --declaration --emitDeclarationOnly --outDir dist", {
  stdio: "inherit",
  cwd: import.meta.dir,
});

console.log("✓ Type declarations emitted");
