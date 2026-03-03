#!/usr/bin/env bun
/**
 * Monorepo directory reorganization script (Phase 3, Decision 1A).
 *
 * Moves 197 packages from packages/<name> into packages/<subsystem>/<name>
 * using 15 Linux-inspired subsystem directories. Package names and import
 * paths are unchanged — only filesystem locations change.
 *
 * Usage: bun scripts/reorganize.ts [--dry-run]
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Package → subsystem mapping (from issue #709)
// ---------------------------------------------------------------------------

const SUBSYSTEM_MAP: Readonly<Record<string, string>> = {
  // kernel/ — L0 + L1 + bootstrap
  core: "kernel",
  engine: "kernel",
  bootstrap: "kernel",
  config: "kernel",
  manifest: "kernel",
  soul: "kernel",

  // mm/ — memory, context, transcript
  context: "mm",
  "memory-fs": "mm",
  "knowledge-vault": "mm",
  transcript: "mm",
  "session-store": "mm",
  "snapshot-store-sqlite": "mm",
  "middleware-compactor": "mm",
  "middleware-context-editing": "mm",
  "middleware-hot-memory": "mm",
  "middleware-personalization": "mm",
  "middleware-preference": "mm",
  "middleware-ace": "mm",
  "tool-squash": "mm",
  "session-repair": "mm",
  "snapshot-chain-store": "mm",
  "token-estimator": "mm",

  // net/ — channels, gateway, networking
  gateway: "net",
  "channel-base": "net",
  "channel-canvas-fallback": "net",
  "channel-chat-sdk": "net",
  "channel-cli": "net",
  "channel-discord": "net",
  "channel-email": "net",
  "channel-matrix": "net",
  "channel-mobile": "net",
  "channel-signal": "net",
  "channel-slack": "net",
  "channel-teams": "net",
  "channel-telegram": "net",
  "channel-voice": "net",
  "channel-whatsapp": "net",
  canvas: "net",
  mcp: "net",
  "mcp-server": "net",
  acp: "net",
  "acp-protocol": "net",
  "webhook-delivery": "net",
  "webhook-provider": "net",
  "name-service": "net",

  // drivers/ — engine adapters, model routing
  "engine-claude": "drivers",
  "engine-pi": "drivers",
  "engine-loop": "drivers",
  "engine-acp": "drivers",
  "engine-external": "drivers",
  "engine-rlm": "drivers",
  "model-router": "drivers",
  "browser-playwright": "drivers",

  // security/ — permissions, governance, audit
  delegation: "security",
  "exec-approvals": "security",
  "permissions-nexus": "security",
  "capability-verifier": "security",
  "collusion-detector": "security",
  "security-analyzer": "security",
  reputation: "security",
  doctor: "security",
  redaction: "security",
  "governance-memory": "security",
  "audit-sink-local": "security",
  "audit-sink-nexus": "security",
  "middleware-permissions": "security",
  "middleware-governance-backend": "security",
  "middleware-delegation-escalation": "security",
  "middleware-audit": "security",
  "middleware-pii": "security",
  "middleware-sanitize": "security",
  "middleware-guardrails": "security",
  "middleware-intent-capsule": "security",
  "middleware-pay": "security",
  scope: "security",

  // ipc/ — inter-process communication, orchestration
  "ipc-local": "ipc",
  "ipc-nexus": "ipc",
  handoff: "ipc",
  orchestrator: "ipc",
  "parallel-minions": "ipc",
  "task-spawn": "ipc",
  "competitive-broadcast": "ipc",
  "scratchpad-local": "ipc",
  "scratchpad-nexus": "ipc",
  workspace: "ipc",
  "workspace-nexus": "ipc",
  federation: "ipc",

  // fs/ — filesystem, tools, stores, search
  filesystem: "fs",
  "tool-exec": "fs",
  "tool-browser": "fs",
  "tool-ask-user": "fs",
  "tool-ask-guide": "fs",
  "tools-github": "fs",
  "tools-web": "fs",
  skills: "fs",
  "code-mode": "fs",
  lsp: "fs",
  search: "fs",
  "search-brave": "fs",
  "search-nexus": "fs",
  "store-fs": "fs",
  "store-nexus": "fs",
  "store-sqlite": "fs",
  "registry-event-sourced": "fs",
  "registry-nexus": "fs",
  "registry-http": "fs",
  "registry-store": "fs",
  "events-memory": "fs",
  "events-nexus": "fs",
  "events-sqlite": "fs",
  "pay-local": "fs",
  "pay-nexus": "fs",
  catalog: "fs",
  "artifact-client": "fs",
  "worktree-merge": "fs",
  resolve: "fs",
  "search-provider": "fs",
  "skill-scanner": "fs",

  // virt/ — sandboxes, code execution
  sandbox: "virt",
  "sandbox-docker": "virt",
  "sandbox-e2b": "virt",
  "sandbox-vercel": "virt",
  "sandbox-cloudflare": "virt",
  "sandbox-daytona": "virt",
  "sandbox-executor": "virt",
  "sandbox-ipc": "virt",
  "code-executor": "virt",
  "sandbox-cloud-base": "virt",
  "sandbox-wasm": "virt",

  // sched/ — scheduling, long-running, harness
  scheduler: "sched",
  "scheduler-nexus": "sched",
  "scheduler-provider": "sched",
  "long-running": "sched",
  "verified-loop": "sched",
  "harness-scheduler": "sched",

  // forge/ — self-extension, crystallization
  "forge-demand": "forge",
  "forge-exaptation": "forge",
  "forge-integrity": "forge",
  "forge-optimizer": "forge",
  "forge-policy": "forge",
  "forge-tools": "forge",
  "forge-verifier": "forge",
  crystallize: "forge",
  "forge-types": "forge",

  // observability/ — monitoring, debugging, tracing
  "agent-procfs": "observability",
  "agent-monitor": "observability",
  "agent-discovery": "observability",
  "dashboard-api": "observability",
  "dashboard-ui": "observability",
  agui: "observability",
  debug: "observability",
  eval: "observability",
  tracing: "observability",
  "self-test": "observability",
  "middleware-event-trace": "observability",
  "dashboard-types": "observability",

  // middleware/ — generic middleware (not domain-specific)
  "middleware-call-dedup": "middleware",
  "middleware-call-limits": "middleware",
  "middleware-degenerate": "middleware",
  "middleware-feedback-loop": "middleware",
  "middleware-fs-rollback": "middleware",
  "middleware-goal-anchor": "middleware",
  "middleware-goal-reminder": "middleware",
  "middleware-guided-retry": "middleware",
  "middleware-output-verifier": "middleware",
  "middleware-planning": "middleware",
  "middleware-report": "middleware",
  "middleware-sandbox": "middleware",
  "middleware-semantic-retry": "middleware",
  "middleware-tool-audit": "middleware",
  "middleware-tool-recovery": "middleware",
  "middleware-tool-selector": "middleware",
  "middleware-turn-ack": "middleware",

  // lib/ — shared utilities
  "crypto-utils": "lib",
  "edit-match": "lib",
  errors: "lib",
  "event-delivery": "lib",
  "execution-context": "lib",
  "file-resolution": "lib",
  "git-utils": "lib",
  hash: "lib",
  "nexus-client": "lib",
  shutdown: "lib",
  "sqlite-utils": "lib",
  "test-utils": "lib",
  validation: "lib",
  "variant-selection": "lib",

  // meta/ — convenience bundles, CLI
  autonomous: "meta",
  cli: "meta",
  "context-arena": "meta",
  forge: "meta",
  governance: "meta",
  "sandbox-stack": "meta",
  starter: "meta",

  // deploy/ — deployment, bundling
  node: "deploy",
  deploy: "deploy",
  bundle: "deploy",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string): void {
  if (DRY_RUN) {
    console.log(`[DRY RUN] ${cmd}`);
  } else {
    execSync(cmd, { cwd: ROOT, stdio: "inherit" });
  }
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(ROOT, filePath), "utf-8"));
}

function writeJson(filePath: string, data: unknown): void {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would write ${filePath}`);
  } else {
    fs.writeFileSync(path.join(ROOT, filePath), content);
  }
}

function readText(filePath: string): string {
  return fs.readFileSync(path.join(ROOT, filePath), "utf-8");
}

function writeText(filePath: string, content: string): void {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would write ${filePath}`);
  } else {
    fs.writeFileSync(path.join(ROOT, filePath), content);
  }
}

// ---------------------------------------------------------------------------
// Step 1: Validate mapping covers all packages
// ---------------------------------------------------------------------------

console.log("Step 1: Validating package mapping...");

const allPackages = fs.readdirSync(path.join(ROOT, "packages")).filter((name) => {
  const pkgPath = path.join(ROOT, "packages", name, "package.json");
  return fs.existsSync(pkgPath);
});

const unmapped: string[] = [];
for (const pkg of allPackages) {
  if (SUBSYSTEM_MAP[pkg] === undefined) {
    unmapped.push(pkg);
  }
}

if (unmapped.length > 0) {
  console.error(`ERROR: ${String(unmapped.length)} unmapped packages:`);
  for (const pkg of unmapped) {
    console.error(`  - ${pkg}`);
  }
  process.exit(1);
}

console.log(`  ✓ All ${String(allPackages.length)} packages mapped to subsystems`);

// ---------------------------------------------------------------------------
// Step 2: Clean build artifacts to prevent git mv target conflicts
// ---------------------------------------------------------------------------

// Gitignored dirs (dist/, .turbo/, node_modules/) inside packages can cause
// `git mv` to see the target as an existing directory and move INTO it instead
// of renaming. Remove them first — they'll be regenerated by `bun install` + build.
console.log("Step 2: Cleaning build artifacts from packages...");

const ARTIFACT_DIRS = ["dist", ".turbo", "node_modules"] as const;
for (const pkg of allPackages) {
  for (const artifact of ARTIFACT_DIRS) {
    const artifactPath = path.join(ROOT, "packages", pkg, artifact);
    if (fs.existsSync(artifactPath)) {
      if (!DRY_RUN) {
        fs.rmSync(artifactPath, { recursive: true, force: true });
      }
    }
  }
}
console.log("  ✓ Cleaned dist/, .turbo/, node_modules/ from all packages");

// ---------------------------------------------------------------------------
// Step 3: Handle collision packages (pkg name matches ANY subsystem name)
// ---------------------------------------------------------------------------

// Detect packages whose directory name collides with a subsystem directory name.
// e.g., package "deploy" blocks creation of subsystem dir "deploy/",
//       package "forge" blocks creation of subsystem dir "forge/".
// Fix: move colliding packages to temp names, create subsystem dirs, then move to final.
const subsystemNames = new Set(Object.values(SUBSYSTEM_MAP));
const collisions = allPackages.filter((pkg) => subsystemNames.has(pkg));

if (collisions.length > 0) {
  console.log(`Step 3: Moving ${String(collisions.length)} collision package(s) to temp...`);
  for (const pkg of collisions) {
    run(`git mv packages/${pkg} packages/_tmp_${pkg}`);
    console.log(`  packages/${pkg}/ → packages/_tmp_${pkg}/`);
  }
}

// ---------------------------------------------------------------------------
// Step 4: Create subsystem directories
// ---------------------------------------------------------------------------

console.log("Step 4: Creating subsystem directories...");

const subsystems = [...new Set(Object.values(SUBSYSTEM_MAP))].sort();
for (const subsystem of subsystems) {
  const dir = path.join(ROOT, "packages", subsystem);
  if (!fs.existsSync(dir)) {
    if (!DRY_RUN) {
      fs.mkdirSync(dir, { recursive: true });
    }
    console.log(`  Created packages/${subsystem}/`);
  }
}

// ---------------------------------------------------------------------------
// Step 5: Move packages via git mv
// ---------------------------------------------------------------------------

console.log("Step 5: Moving packages...");

for (const pkg of allPackages) {
  const subsystem = SUBSYSTEM_MAP[pkg];
  if (subsystem === undefined) continue; // already validated
  const src = collisions.includes(pkg) ? `packages/_tmp_${pkg}` : `packages/${pkg}`;
  const dst = `packages/${subsystem}/${pkg}`;
  run(`git mv ${src} ${dst}`);
}

console.log(`  ✓ Moved ${String(allPackages.length)} packages`);

// ---------------------------------------------------------------------------
// Step 6: Update root package.json workspaces
// ---------------------------------------------------------------------------

console.log("Step 6: Updating package.json workspaces...");

const rootPkg = readJson("package.json") as Record<string, unknown>;
rootPkg.workspaces = ["packages/*/*", "apps/*", "tests/e2e", "recipes/*"];
writeJson("package.json", rootPkg);

console.log("  ✓ Updated workspaces glob to packages/*/*");

// ---------------------------------------------------------------------------
// Step 7: Update turbo.json inputs
// ---------------------------------------------------------------------------

console.log("Step 7: Updating turbo.json...");

let turboText = readText("turbo.json");
turboText = turboText.replace(/packages\/\*\//g, "packages/*/*/");
// Avoid double-globbing (packages/*/*/*/) if script is run twice
turboText = turboText.replace(/packages\/\*\/\*\/\*\//g, "packages/*/*/");
writeText("turbo.json", turboText);

console.log("  ✓ Updated turbo.json input globs");

// ---------------------------------------------------------------------------
// Step 8: Fix per-package tsconfig.json extends paths
// ---------------------------------------------------------------------------

console.log("Step 8: Fixing per-package tsconfig.json extends...");

let fixedTsconfigs = 0;
const TSCONFIG_NAMES = ["tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"] as const;
for (const [pkg, subsystem] of Object.entries(SUBSYSTEM_MAP)) {
  for (const tsconfigName of TSCONFIG_NAMES) {
    const fullPath = path.join(ROOT, "packages", subsystem, pkg, tsconfigName);
    if (fs.existsSync(fullPath)) {
      let content = fs.readFileSync(fullPath, "utf-8");
      if (content.includes('"../../tsconfig.base.json"')) {
        content = content.replace('"../../tsconfig.base.json"', '"../../../tsconfig.base.json"');
        if (!DRY_RUN) {
          fs.writeFileSync(fullPath, content);
        }
        fixedTsconfigs++;
      }
    }
  }
}
console.log(`  ✓ Fixed ${String(fixedTsconfigs)} per-package tsconfig extends paths`);

// ---------------------------------------------------------------------------
// Step 9: Update root tsconfig.json references
// ---------------------------------------------------------------------------

console.log("Step 9: Updating tsconfig.json references...");

const tsconfig = readJson("tsconfig.json") as {
  references: Array<{ path: string }>;
};

tsconfig.references = tsconfig.references.map((ref) => {
  // Match packages/<name> and rewrite to packages/<subsystem>/<name>
  const match = ref.path.match(/^packages\/([^/]+)$/);
  if (match !== null) {
    const pkgName = match[1];
    if (pkgName !== undefined) {
      const subsystem = SUBSYSTEM_MAP[pkgName];
      if (subsystem !== undefined) {
        return { path: `packages/${subsystem}/${pkgName}` };
      }
    }
  }
  return ref;
});

writeJson("tsconfig.json", tsconfig);

console.log(`  ✓ Updated ${String(tsconfig.references.length)} tsconfig references`);

// ---------------------------------------------------------------------------
// Step 10: Update CI path filters
// ---------------------------------------------------------------------------

console.log("Step 10: Updating CI path filters...");

const ciPath = ".github/workflows/ci-L0.yml";
if (fs.existsSync(path.join(ROOT, ciPath))) {
  let ciText = readText(ciPath);
  ciText = ciText.replace(/packages\/core\//g, "packages/kernel/core/");
  writeText(ciPath, ciText);
  console.log("  ✓ Updated ci-L0.yml path filters");
} else {
  console.log("  ⚠ ci-L0.yml not found, skipping");
}

// ---------------------------------------------------------------------------
// Step 11: Update check-layers.ts
// ---------------------------------------------------------------------------

console.log("Step 11: Updating check-layers.ts...");

const checkLayersPath = "scripts/check-layers.ts";
if (fs.existsSync(path.join(ROOT, checkLayersPath))) {
  let checkLayersText = readText(checkLayersPath);
  // Update any hardcoded paths like `${PACKAGES_DIR}core/src` or `packages/core`
  // The script uses PACKAGES_DIR = path.join(ROOT, "packages") + "/";
  // References like `${PACKAGES_DIR}core/src` → `${PACKAGES_DIR}kernel/core/src`
  for (const [pkg, subsystem] of Object.entries(SUBSYSTEM_MAP)) {
    // Pattern: PACKAGES_DIR followed by the package name and /
    const pattern = new RegExp(`(PACKAGES_DIR[^}]*})${pkg}/`, "g");
    checkLayersText = checkLayersText.replace(pattern, `$1${subsystem}/${pkg}/`);
    // Pattern: "packages/<name>/"
    const pathPattern = new RegExp(`"packages/${pkg}/"`, "g");
    checkLayersText = checkLayersText.replace(pathPattern, `"packages/${subsystem}/${pkg}/"`);
  }
  writeText(checkLayersPath, checkLayersText);
  console.log("  ✓ Updated check-layers.ts paths");
} else {
  console.log("  ⚠ check-layers.ts not found, skipping");
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log("\n✓ Reorganization complete!");
console.log("\nNext steps:");
console.log("  1. bun install");
console.log("  2. turbo run build");
console.log("  3. turbo run test");
console.log("  4. bun run scripts/check-layers.ts");
