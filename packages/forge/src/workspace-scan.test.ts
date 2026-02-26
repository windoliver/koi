import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyConfig } from "./config.js";
import { scanWorkspaceCode } from "./workspace-scan.js";

const DEFAULT_CONFIG: DependencyConfig = {
  maxDependencies: 20,
  installTimeoutMs: 15_000,
  maxCacheSizeBytes: 1_073_741_824,
  maxWorkspaceAgeDays: 30,
  maxTransitiveDependencies: 200,
  maxBrickMemoryMb: 256,
  maxBrickPids: 32,
};

// let justified: mutable test workspace path
let workspacePath: string;

beforeEach(async () => {
  workspacePath = join(tmpdir(), `scan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(workspacePath, "node_modules", "safe-pkg"), { recursive: true });
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
});

describe("scanWorkspaceCode", () => {
  test("returns ok with empty findings for safe code", async () => {
    await writeFile(
      join(workspacePath, "node_modules", "safe-pkg", "index.js"),
      "module.exports = function add(a, b) { return a + b; };",
      "utf8",
    );
    const result = await scanWorkspaceCode(workspacePath, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.findings.length).toBe(0);
      expect(result.value.scannedFiles).toBeGreaterThan(0);
    }
  });

  test("rejects critical pattern: child_process", async () => {
    await writeFile(
      join(workspacePath, "node_modules", "safe-pkg", "index.js"),
      'const cp = require("child_process");\ncp.exec("rm -rf /");',
      "utf8",
    );
    const result = await scanWorkspaceCode(workspacePath, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUDIT_FAILED");
      expect(result.error.message).toContain("child_process");
    }
  });

  test("rejects critical pattern: execSync", async () => {
    await writeFile(
      join(workspacePath, "node_modules", "safe-pkg", "index.js"),
      'const { execSync } = require("child_process");\nexecSync("whoami");',
      "utf8",
    );
    const result = await scanWorkspaceCode(workspacePath, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("execSync");
    }
  });

  test("returns warning for eval() without blocking", async () => {
    await writeFile(
      join(workspacePath, "node_modules", "safe-pkg", "index.js"),
      "module.exports = function run(code) { return eval(code); };",
      "utf8",
    );
    const result = await scanWorkspaceCode(workspacePath, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const evalFindings = result.value.findings.filter((f) => f.pattern === "eval()");
      expect(evalFindings.length).toBe(1);
      expect(evalFindings[0]?.severity).toBe("warning");
    }
  });

  test("returns warning for process.env access", async () => {
    await writeFile(
      join(workspacePath, "node_modules", "safe-pkg", "index.js"),
      "const key = process.env.SECRET_KEY;",
      "utf8",
    );
    const result = await scanWorkspaceCode(workspacePath, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const envFindings = result.value.findings.filter((f) => f.pattern === "process.env access");
      expect(envFindings.length).toBe(1);
    }
  });

  test("skips non-JS files", async () => {
    await writeFile(
      join(workspacePath, "node_modules", "safe-pkg", "README.md"),
      "You can use child_process to run commands.",
      "utf8",
    );
    const result = await scanWorkspaceCode(workspacePath, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.findings.length).toBe(0);
    }
  });

  test("scans .mjs and .cjs files", async () => {
    await writeFile(
      join(workspacePath, "node_modules", "safe-pkg", "index.mjs"),
      'import { execSync } from "child_process";',
      "utf8",
    );
    const result = await scanWorkspaceCode(workspacePath, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("child_process");
    }
  });

  test("handles missing node_modules gracefully", async () => {
    const emptyWorkspace = join(
      tmpdir(),
      `empty-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(emptyWorkspace, { recursive: true });
    const result = await scanWorkspaceCode(emptyWorkspace, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scannedFiles).toBe(0);
    }
    await rm(emptyWorkspace, { recursive: true, force: true }).catch(() => {});
  });

  test("detects multiple critical patterns in different files", async () => {
    await mkdir(join(workspacePath, "node_modules", "evil-pkg"), { recursive: true });
    await writeFile(
      join(workspacePath, "node_modules", "safe-pkg", "index.js"),
      'const { spawnSync } = require("child_process");',
      "utf8",
    );
    await writeFile(
      join(workspacePath, "node_modules", "evil-pkg", "index.js"),
      'const { execFileSync } = require("child_process");',
      "utf8",
    );
    const result = await scanWorkspaceCode(workspacePath, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Dangerous code patterns");
    }
  });
});
