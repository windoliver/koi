/**
 * Prebuild script — bundles worker-entry.ts into WORKER_SCRIPT string constant.
 *
 * Usage: bun run scripts/generate-worker-source.ts
 *
 * This ensures zero drift between the tested source (worker-exec.ts) and
 * the embedded script string (worker-source.ts). The generated file is
 * committed to git so downstream consumers don't need this build step.
 */

const ENTRY = "src/worker-entry.ts";
const OUTPUT = "src/worker-source.ts";

const result = await Bun.build({
  entrypoints: [ENTRY],
  target: "bun",
  format: "esm",
  minify: false,
  bundle: true,
});

if (!result.success) {
  console.error("❌ Worker bundle failed:");
  for (const log of result.logs) {
    console.error("  ", log.message);
  }
  process.exit(1);
}

const output = result.outputs[0];
if (!output) {
  console.error("❌ No output from Bun.build");
  process.exit(1);
}

const bundled = await output.text();

// Verify the bundle is self-contained (no import/export statements remaining)
if (/^\s*(import|export)\s/m.test(bundled)) {
  console.error("❌ Bundle contains import/export statements — not self-contained");
  console.error("   Hint: worker-exec.ts must have zero imports from project packages");
  process.exit(1);
}

const header = [
  "/**",
  " * AUTO-GENERATED — do not edit manually.",
  " *",
  " * Source: src/worker-entry.ts + src/worker-exec.ts",
  " * Generator: scripts/generate-worker-source.ts",
  " * Regenerate: bun run prebuild",
  " */",
  "",
].join("\n");

const source = `${header}\nexport const WORKER_SCRIPT = ${JSON.stringify(bundled)};\n`;

await Bun.write(OUTPUT, source);

// Report bundle size
const sizeBytes = Buffer.byteLength(bundled, "utf8");
const sizeKb = (sizeBytes / 1024).toFixed(1);
console.log(`✅ Generated ${OUTPUT} (${sizeKb} KB bundle)`);
