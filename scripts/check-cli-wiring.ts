#!/usr/bin/env bun
/**
 * CI enforcement — verifies the TUI CLI wires every @koi/* package that
 * the golden-query runtime (@koi/runtime) depends on.
 *
 * Source of truth: @koi/runtime's package.json dependencies — the same
 * source that check:orphans uses for runtime wiring. If a package is
 * wired into the golden harness, it must also be wired into the TUI.
 *
 * Phase 1: @koi/runtime deps must appear in @koi-agent/cli dependencies
 * Phase 2: @koi/runtime deps must be imported in the TUI runtime wiring sources
 *
 * Usage: bun scripts/check-cli-wiring.ts
 */

import { L0_PACKAGES, L0U_PACKAGES, L1_PACKAGES } from "./layers.js";

const ROOT = new URL("../", import.meta.url).pathname;
const CLI_PKG_PATH = `${ROOT}packages/meta/cli/package.json`;
const RUNTIME_PKG_PATH = `${ROOT}packages/meta/runtime/package.json`;
const TUI_IMPORT_ANALYSIS_PATHS: readonly string[] = [
  `${ROOT}packages/meta/cli/src/tui-command.ts`,
  `${ROOT}packages/meta/cli/src/runtime-factory.ts`,
  `${ROOT}packages/meta/cli/src/shared-wiring.ts`,
  `${ROOT}packages/meta/cli/src/plugin-activation.ts`,
];
const TUI_PRESET_STACKS_GLOB = "packages/meta/cli/src/preset-stacks/*.ts";

/**
 * Packages in @koi/runtime that are intentionally not wired into the TUI.
 * Each entry must have a justification comment.
 */
const EXEMPT: ReadonlySet<string> = new Set([
  // MCP server/client — requires MCP server config (stdio/HTTP transports)
  "@koi/mcp",
  "@koi/mcp-server",
  // Nexus filesystem — requires running Nexus Docker stack
  "@koi/fs-nexus",
  // Skills runtime — requires skill scanner config + filesystem scanning
  "@koi/skills-runtime",
  // Agent runtime — requires agent resolver dirs config
  "@koi/agent-runtime",
  // Hook prompt — requires PromptModelCaller injection
  "@koi/hook-prompt",
  // Memory recall scanner — used internally by memory-tools, not a standalone provider
  "@koi/memory",
  // Memory filesystem store — used internally by memory-tools, not a standalone provider
  "@koi/memory-fs",
  // Goal middleware — requires objectives config (no-op without goals)
  "@koi/middleware-goal",
  // Report middleware — requires objective + sink config (no-op without objective)
  "@koi/middleware-report",
  // Reflex middleware — opt-in (koi.optional: true), requires user-defined rules array
  "@koi/middleware-reflex",
  // Turn-ack middleware — opt-in (koi.optional: true), TUI has its own status indicator
  "@koi/middleware-turn-ack",
  // Prompt-cache middleware — opt-in (koi.optional: true), no adapter consumes CACHE_HINTS_KEY yet
  "@koi/middleware-prompt-cache",
  // S3 artifact backend — optional storage adapter; TUI wires local @koi/artifacts.
  "@koi/artifacts-s3",
  // Team memory sync — golden/runtime-only batch sync, no interactive TUI surface.
  "@koi/memory-team-sync",
  // Strict agentic middleware — golden cassette policy harness, not default TUI policy.
  "@koi/middleware-strict-agentic",
  // Outcome evaluator — LLM-as-judge cassette harness, not default TUI middleware.
  "@koi/outcome-evaluator",
  // Browser tools — require a BrowserDriver/backend that TUI does not construct.
  "@koi/tool-browser",
  // Browser drivers — only used when a browser backend is explicitly configured.
  "@koi/browser-ext",
  "@koi/browser-playwright",
  // Debug package — opt-in (koi.optional: true), not part of default TUI runtime.
  "@koi/debug",
  // Demand-forge package — opt-in (koi.optional: true), not default TUI middleware.
  "@koi/forge-demand",
  // Gateway stack — server/webhook transports, not interactive local TUI wiring.
  "@koi/gateway",
  "@koi/gateway-webhook",
  // Delegation/security helpers — require explicit delegation or Nexus configuration.
  "@koi/governance-delegation",
  "@koi/governance-security",
  "@koi/nexus-delegation",
  // Local IPC backend — multi-agent routing backend, not default single TUI session.
  "@koi/ipc-local",
  // Long-running harness — alternate execution mode, not default interactive TUI wiring.
  "@koi/long-running",
  // Optional middleware packages that require explicit host configuration.
  "@koi/middleware-call-dedup",
  "@koi/middleware-collective-memory",
  "@koi/middleware-degenerate",
  "@koi/middleware-output-verifier",
  // Scratchpad/workspace/toolset components are opt-in runtime providers.
  "@koi/scratchpad-local",
  "@koi/toolsets",
  "@koi/workspace",
  // Temporal adapter — optional durable execution backend, not default local TUI.
  "@koi/temporal",
]);

/**
 * Core infrastructure packages that the CLI needs as dependencies but
 * aren't L2 tool/middleware packages (don't need to be in tui-runtime.ts).
 * These are checked in Phase 1 (dependency) but skipped in Phase 2 (import).
 */
const INFRA_ONLY: ReadonlySet<string> = new Set([
  "@koi/core",
  "@koi/engine",
  "@koi/query-engine",
  // Used by tui-command.ts or koi start, not tui-runtime.ts
  "@koi/channel-cli",
  "@koi/daemon",
  "@koi/harness",
  "@koi/lsp",
  "@koi/model-openai-compat",
  // TUI spawn is wired through @koi/engine's createSpawnToolProvider.
  "@koi/spawn-tools",
]);

function getKoiDeps(deps: Record<string, string> | undefined): readonly string[] {
  if (deps === undefined) return [];
  return Object.keys(deps).filter((d) => d.startsWith("@koi/"));
}

function isInfraLayer(name: string): boolean {
  return L0_PACKAGES.has(name) || L0U_PACKAGES.has(name) || L1_PACKAGES.has(name);
}

async function collectTuiImportAnalysisSource(): Promise<{
  readonly source: string;
  readonly paths: readonly string[];
}> {
  const paths: string[] = [];
  for (const path of TUI_IMPORT_ANALYSIS_PATHS) {
    if (await Bun.file(path).exists()) paths.push(path);
  }

  const glob = new Bun.Glob(TUI_PRESET_STACKS_GLOB);
  for await (const path of glob.scan({ cwd: ROOT, absolute: true })) {
    paths.push(path);
  }

  paths.sort();
  const source = (await Promise.all(paths.map((path) => Bun.file(path).text()))).join("\n");
  return { source, paths };
}

interface PackageJson {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

async function main(): Promise<void> {
  // ── Read @koi/runtime dependencies (source of truth) ───────────────────

  const runtimeFile = Bun.file(RUNTIME_PKG_PATH);
  if (!(await runtimeFile.exists())) {
    console.error(`\n✗ @koi/runtime package.json not found at ${RUNTIME_PKG_PATH}`);
    process.exit(1);
  }

  const runtimePkg = (await runtimeFile.json()) as PackageJson;
  const runtimeDeps = getKoiDeps(runtimePkg.dependencies);

  // Filter to packages the TUI should wire (skip exempt, infra-only L0/L0u/L1)
  const requiredForTui = runtimeDeps.filter((name) => !EXEMPT.has(name) && !isInfraLayer(name));

  if (requiredForTui.length === 0) {
    console.log("\n⏭️  No L2 packages found in @koi/runtime dependencies.");
    return;
  }

  // ── Phase 1: CLI package.json dependencies ──────────────────────────────

  const cliFile = Bun.file(CLI_PKG_PATH);
  if (!(await cliFile.exists())) {
    console.error(`\n✗ @koi-agent/cli package.json not found at ${CLI_PKG_PATH}`);
    process.exit(1);
  }

  const cliPkg = (await cliFile.json()) as PackageJson;
  const cliDeps = new Set(Object.keys(cliPkg.dependencies ?? {}));
  const cliDevDeps = new Set(Object.keys(cliPkg.devDependencies ?? {}));

  const missing: string[] = [];
  const devOnly: string[] = [];

  for (const name of requiredForTui) {
    if (!cliDeps.has(name)) {
      if (cliDevDeps.has(name)) {
        devOnly.push(name);
      } else {
        missing.push(name);
      }
    }
  }

  let failed = false;

  if (devOnly.length > 0) {
    console.error(
      `\n${devOnly.length} package(s) in @koi/runtime but only in CLI devDependencies:\n`,
    );
    for (const name of devOnly.sort()) {
      console.error(`  ✗ ${name}  (move from devDependencies → dependencies)`);
    }
    failed = true;
  }

  if (missing.length > 0) {
    console.error(
      `\n${missing.length} package(s) in @koi/runtime but missing from CLI dependencies:\n`,
    );
    for (const name of missing.sort()) {
      console.error(`  ✗ ${name}`);
    }
    console.error(
      "\n  Fix: add to packages/meta/cli/package.json dependencies," +
        "\n  or add to EXEMPT in scripts/check-cli-wiring.ts with justification.\n",
    );
    failed = true;
  }

  if (!failed) {
    console.log(`\n✅ All ${requiredForTui.length} @koi/runtime L2 deps are in CLI dependencies.`);
  }

  // ── Phase 2: TUI runtime wiring import analysis ─────────────────────────

  const tuiWiring = await collectTuiImportAnalysisSource();
  if (tuiWiring.paths.length === 0) {
    console.log("\n⏭️  TUI runtime wiring sources not found — skipping import analysis.");
    if (failed) process.exit(1);
    return;
  }

  const source = tuiWiring.source;
  const importRegex = /(?:from|import)\s+["'](@koi\/[^/"']+)/g;
  const cliImports = new Set<string>();
  for (const match of source.matchAll(importRegex)) {
    if (match[1] !== undefined) cliImports.add(match[1]);
  }

  // Only check L2 tool/middleware packages (skip infra — they're used
  // in tui-command.ts or engine-adapter.ts, not tui-runtime.ts)
  const notImported: string[] = [];
  for (const name of requiredForTui) {
    if (INFRA_ONLY.has(name)) continue;
    if (!cliImports.has(name)) {
      notImported.push(name);
    }
  }

  if (notImported.length > 0) {
    console.error(
      `\n${notImported.length} @koi/runtime L2 package(s) not imported in TUI wiring sources:\n`,
    );
    for (const name of notImported.sort()) {
      console.error(`  ✗ ${name}`);
    }
    console.error(
      "\n  Fix: import and wire in the TUI runtime wiring sources," +
        "\n  or add to EXEMPT in scripts/check-cli-wiring.ts with justification.\n",
    );
    failed = true;
  } else {
    const checked = requiredForTui.filter((n) => !INFRA_ONLY.has(n)).length;
    console.log(
      `✅ All ${checked} @koi/runtime L2 packages are imported in TUI wiring sources ` +
        `(${String(tuiWiring.paths.length)} files).`,
    );
  }

  if (EXEMPT.size > 0) {
    console.log(`   (${EXEMPT.size} package(s) explicitly exempt: ${[...EXEMPT].join(", ")})`);
  }

  if (failed) process.exit(1);
}

await main();
