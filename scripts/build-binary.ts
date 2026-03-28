#!/usr/bin/env bun
/**
 * Standalone binary builder for Koi.
 *
 * Uses `bun build --compile` to produce self-contained executables that
 * do not require Bun to be installed on the target machine.
 *
 * Usage:
 *   bun scripts/build-binary.ts                        # Build for current platform
 *   bun scripts/build-binary.ts --all                  # Cross-compile for all targets
 *   bun scripts/build-binary.ts --target bun-linux-x64 # Build for specific target
 *   bun scripts/build-binary.ts --skip-build           # Skip turborepo build step
 *
 * Output:
 *   dist/koi-{platform}-{arch}   (e.g. dist/koi-darwin-arm64)
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MONOREPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const CLI_PACKAGE_DIR = resolve(MONOREPO_ROOT, "packages/meta/cli");
const ENTRY_POINT = resolve(CLI_PACKAGE_DIR, "src/bin.ts");
const DIST_DIR = resolve(MONOREPO_ROOT, "dist");
const DESCRIPTOR_MANIFEST_SCRIPT = resolve(
  MONOREPO_ROOT,
  "scripts/generate-descriptor-manifest.ts",
);

/**
 * Packages to exclude from the bundle. These are optional deps that require
 * native binaries or platform-specific installations. They remain available
 * as optional features if installed on the target machine.
 *
 * Categories:
 * - Browser automation: playwright requires downloadable browser binaries
 * - Temporal: requires a Temporal server and native worker binaries
 * - Cloud sandboxes: require external service accounts (e2b, Vercel)
 * - Build tools: swc/loader-utils are build-time only
 */
const EXTERNAL_PACKAGES = [
  // Browser automation — requires downloadable browser binaries
  "@koi/browser-playwright",
  "playwright-core",
  "playwright",
  "electron",
  "chromium-bidi",
  // Build tooling — not needed at runtime
  "loader-utils",
  "swc-loader",
  "@swc/wasm",
  "@swc/core",
  // Temporal workflow engine — optional runtime dep
  "@temporalio/client",
  "@temporalio/worker",
  // Cloud sandbox providers — require external accounts
  "@vercel/sandbox",
  "e2b",
  // Voice/audio — require native codecs and ffmpeg binary
  "ffmpeg-static",
  "prism-media",
  "@discordjs/voice",
  "@discordjs/opus",
  "sodium-native",
  "libsodium-wrappers",
  "opusscript",
  // WhatsApp — requires native QR code and baileys WebSocket
  "qrcode-terminal",
  "@whiskeysockets/baileys",
  // Signal — requires native libsignal crypto
  "@niccolocase/libsignal-node",
  "libsignal-client",
  // Matrix — optional native olm crypto
  "@matrix-org/olm",
] as const;

/** Supported Bun compile target triples. */
const TARGET_TRIPLES = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;

type TargetTriple = (typeof TARGET_TRIPLES)[number];

/** Map from process.platform + process.arch to Bun target triple. */
const PLATFORM_MAP: Readonly<Record<string, TargetTriple | undefined>> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectCurrentTarget(): TargetTriple {
  const key = `${process.platform}-${process.arch}`;
  const triple = PLATFORM_MAP[key];
  if (triple === undefined) {
    throw new Error(
      `Unsupported platform: ${key}. Supported: ${Object.keys(PLATFORM_MAP).join(", ")}`,
    );
  }
  return triple;
}

function outputName(target: TargetTriple): string {
  // bun-darwin-arm64 -> koi-darwin-arm64
  return `koi-${target.replace("bun-", "")}`;
}

interface ParsedArgs {
  readonly targets: readonly TargetTriple[];
  readonly skipBuild: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2);
  const skipBuild = args.includes("--skip-build");

  let targets: readonly TargetTriple[];

  if (args.includes("--all")) {
    targets = TARGET_TRIPLES;
  } else {
    const targetIdx = args.indexOf("--target");
    if (targetIdx !== -1) {
      const value = args[targetIdx + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--target requires a value (e.g. bun-linux-x64)");
      }
      if (!TARGET_TRIPLES.includes(value as TargetTriple)) {
        throw new Error(`Unknown target: ${value}. Valid targets: ${TARGET_TRIPLES.join(", ")}`);
      }
      targets = [value as TargetTriple];
    } else {
      // Default: current platform only
      targets = [detectCurrentTarget()];
    }
  }

  return { targets, skipBuild };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Build steps
// ---------------------------------------------------------------------------

async function generateDescriptorManifest(): Promise<void> {
  console.log("Generating descriptor manifest...");

  if (!existsSync(DESCRIPTOR_MANIFEST_SCRIPT)) {
    console.log("  Descriptor manifest script not found, skipping.");
    return;
  }

  const proc = Bun.spawn(["bun", DESCRIPTOR_MANIFEST_SCRIPT], {
    cwd: MONOREPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.warn(`  Warning: descriptor manifest generation failed (exit ${String(exitCode)})`);
    if (stderr.length > 0) {
      console.warn(`  ${stderr.trim()}`);
    }
    console.warn("  Continuing without embedded manifest.");
  } else {
    console.log("  Descriptor manifest generated.");
  }
}

async function buildCliPackages(): Promise<void> {
  console.log("Building @koi/cli and dependencies via turborepo...");
  const startMs = performance.now();

  const proc = Bun.spawn(
    ["bunx", "turbo", "run", "build", "--filter=@koi/cli", "--concurrency=4"],
    {
      cwd: MONOREPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const exitCode = await proc.exited;
  const durationMs = performance.now() - startMs;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`CLI package build failed (exit ${String(exitCode)}):\n${stderr}`);
  }

  console.log(`  CLI packages built in ${formatDuration(durationMs)}.`);
}

interface BuildResult {
  readonly target: TargetTriple;
  readonly outputPath: string;
  readonly sizeBytes: number;
  readonly durationMs: number;
}

async function compileBinary(target: TargetTriple): Promise<BuildResult> {
  const outFile = resolve(DIST_DIR, outputName(target));
  const startMs = performance.now();

  console.log(`Building ${outputName(target)} (target: ${target})...`);

  const externalFlags = EXTERNAL_PACKAGES.flatMap((pkg) => ["--external", pkg]);

  const args = [
    "build",
    "--compile",
    "--target",
    target,
    "--outfile",
    outFile,
    ...externalFlags,
    ENTRY_POINT,
  ];

  // Run from the CLI package directory so Bun resolves workspace
  // dependencies via the isolated linker's per-package node_modules.
  const proc = Bun.spawn(["bun", ...args], {
    cwd: CLI_PACKAGE_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const durationMs = performance.now() - startMs;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Build failed for ${target} (exit ${String(exitCode)}):\n${stderr}`);
  }

  const stat = await Bun.file(outFile).stat();
  const sizeBytes = stat?.size ?? 0;

  return { target, outputPath: outFile, sizeBytes, durationMs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { targets, skipBuild } = parseArgs(process.argv);

  console.log(`Koi binary builder`);
  console.log(`  Entry: ${ENTRY_POINT}`);
  console.log(`  Output: ${DIST_DIR}/`);
  console.log(`  Targets: ${targets.join(", ")}`);
  if (skipBuild) {
    console.log(`  Skip build: true (using existing package builds)`);
  }
  console.log();

  // Step 1: Build CLI and all workspace dependencies
  if (skipBuild) {
    console.log("Skipping package build (--skip-build).");
  } else {
    await buildCliPackages();
  }
  console.log();

  // Step 2: Generate descriptor manifest for static resolution
  await generateDescriptorManifest();
  console.log();

  // Step 3: Ensure dist directory exists
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  // Step 4: Build for each target (sequentially — bun build --compile is heavy)
  const totalStart = performance.now();
  const results: BuildResult[] = [];

  for (const target of targets) {
    const result = await compileBinary(target);
    results.push(result);
  }

  const totalDuration = performance.now() - totalStart;

  // Step 5: Print summary
  console.log();
  console.log("Build summary:");
  console.log(`  ${"-".repeat(68)}`);

  for (const result of results) {
    console.log(
      `  ${outputName(result.target).padEnd(24)} ${formatBytes(result.sizeBytes).padStart(10)}   ${formatDuration(result.durationMs).padStart(8)}`,
    );
  }

  console.log(`  ${"-".repeat(68)}`);
  console.log(`  Total: ${formatDuration(totalDuration)}`);
  console.log();

  for (const result of results) {
    console.log(`  ${result.outputPath}`);
  }
}

await main();
