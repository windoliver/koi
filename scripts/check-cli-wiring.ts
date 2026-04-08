#!/usr/bin/env bun
/**
 * CI enforcement — verifies @koi-agent/cli lists all required L2 packages
 * as runtime `dependencies` (not devDependencies).
 *
 * Why this matters: Bun uses an isolated linker — packages can only import
 * their own declared dependencies. An L2 package in devDependencies is
 * available during `bun test` but NOT in a published or deployed CLI binary.
 * This script catches the "works in dev, breaks in prod" class of wiring bugs.
 *
 * Required packages are those directly imported by the CLI's production code
 * (tui-runtime.ts, tui-command.ts, engine-adapter.ts, commands/start.ts).
 * They must appear in `dependencies`, not just `devDependencies`.
 *
 * Usage: bun scripts/check-cli-wiring.ts
 */

const ROOT = new URL("../", import.meta.url).pathname;
const CLI_PKG_PATH = `${ROOT}packages/meta/cli/package.json`;

/**
 * L2/L1/L0 packages that @koi-agent/cli imports in production code.
 *
 * Keep this list in sync with:
 *   - packages/meta/cli/src/tui-runtime.ts   (L2 tool stack)
 *   - packages/meta/cli/src/engine-adapter.ts (@koi/query-engine)
 *   - packages/meta/cli/src/tui-command.ts    (@koi/tui, @koi/model-openai-compat)
 *   - packages/meta/cli/src/commands/start.ts (@koi/channel-cli, @koi/harness, @koi/engine)
 */
const REQUIRED_DEPS = [
  // Core kernel
  "@koi/core",
  "@koi/engine",
  "@koi/query-engine",
  // TUI runtime L2 tool stack (tui-runtime.ts)
  "@koi/event-trace",
  "@koi/fs-local",
  "@koi/hooks",
  "@koi/middleware-permissions",
  "@koi/permissions",
  "@koi/sandbox-os",
  "@koi/tools-bash",
  "@koi/tools-builtin",
  "@koi/tools-web",
  // TUI presentation (tui-command.ts)
  "@koi/model-openai-compat",
  "@koi/tui",
  // Start command (commands/start.ts)
  "@koi/channel-cli",
  "@koi/harness",
] as const;

interface CliPackageJson {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

async function main(): Promise<void> {
  const file = Bun.file(CLI_PKG_PATH);
  if (!(await file.exists())) {
    console.error(`\ncheck:cli-wiring: @koi-agent/cli package.json not found at ${CLI_PKG_PATH}`);
    process.exit(1);
  }

  const pkg = (await file.json()) as CliPackageJson;
  const deps = new Set(Object.keys(pkg.dependencies ?? {}));
  const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));

  const missing: string[] = [];
  const devOnly: string[] = [];

  for (const required of REQUIRED_DEPS) {
    if (!deps.has(required)) {
      if (devDeps.has(required)) {
        // In devDeps but not deps — promoted to production import but not moved
        devOnly.push(required);
      } else {
        missing.push(required);
      }
    }
  }

  let failed = false;

  if (devOnly.length > 0) {
    console.error(
      `\n${devOnly.length} package(s) found only in devDependencies but required at runtime:\n`,
    );
    for (const name of devOnly.sort()) {
      console.error(`  ✗ ${name}  (move from devDependencies → dependencies)`);
    }
    failed = true;
  }

  if (missing.length > 0) {
    console.error(`\n${missing.length} package(s) missing from @koi-agent/cli dependencies:\n`);
    for (const name of missing.sort()) {
      console.error(`  ✗ ${name}`);
    }
    console.error(
      '\n  Fix: add to packages/meta/cli/package.json dependencies with "workspace:*".\n',
    );
    failed = true;
  }

  if (failed) {
    process.exit(1);
  }

  console.log(
    `\n✅ @koi-agent/cli has all ${REQUIRED_DEPS.length} required runtime dependencies declared correctly.`,
  );
}

await main();
