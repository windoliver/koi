/**
 * Workspace code scanner — scans installed node_modules for dangerous patterns.
 *
 * Runs post-install to detect suspicious code in transitive dependencies:
 * eval(), child_process, fs write operations, process.env reads, etc.
 *
 * Returns a list of findings (warnings, not hard blocks) unless a blocklisted
 * pattern is found, which returns an error.
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Result } from "@koi/core";
import type { DependencyConfig, ForgeError } from "@koi/forge-types";
import { resolveError } from "@koi/forge-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanFinding {
  readonly file: string;
  readonly pattern: string;
  readonly severity: "critical" | "warning";
}

export interface ScanResult {
  readonly findings: readonly ScanFinding[];
  readonly scannedFiles: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Patterns that are always critical — immediate rejection. */
const CRITICAL_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bchild_process\b/, label: "child_process" },
  { pattern: /\bexecSync\b/, label: "execSync" },
  { pattern: /\bspawnSync\b/, label: "spawnSync" },
  { pattern: /\bexecFileSync\b/, label: "execFileSync" },
];

/** Patterns that are warnings — flagged but not blocked. */
const WARNING_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\beval\s*\(/, label: "eval()" },
  { pattern: /\bnew\s+Function\s*\(/, label: "new Function()" },
  { pattern: /\bprocess\.env\b/, label: "process.env access" },
  { pattern: /\bfs\.writeFileSync\b/, label: "fs.writeFileSync" },
  { pattern: /\bfs\.unlinkSync\b/, label: "fs.unlinkSync" },
  { pattern: /\bfs\.rmdirSync\b/, label: "fs.rmdirSync" },
  { pattern: /\bfs\.rmSync\b/, label: "fs.rmSync" },
];

/** File extensions to scan. */
const SCANNABLE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

/** Max file size to scan (skip minified bundles). */
const MAX_SCAN_FILE_BYTES = 500_000;

/** Max total files to scan (prevent DoS on huge dependency trees). */
const MAX_SCAN_FILES = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectScanFiles(dir: string, files: string[], depth: number): Promise<void> {
  if (depth > 10 || files.length >= MAX_SCAN_FILES) {
    return;
  }

  // let justified: entries is read from async readdir
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (_: unknown) {
    return;
  }

  for (const entry of entries) {
    if (files.length >= MAX_SCAN_FILES) {
      return;
    }

    // Skip hidden dirs, .bin, and common non-source directories
    if (entry.startsWith(".") || entry === "node_modules") {
      continue;
    }

    const fullPath = join(dir, entry);

    // let justified: entryStat is read from async lstat (not stat — prevents symlink escape)
    let entryStat: Awaited<ReturnType<typeof lstat>>;
    try {
      entryStat = await lstat(fullPath);
    } catch (_: unknown) {
      continue;
    }

    // Skip symlinks — prevents escaping node_modules via malicious symlinks
    if (entryStat.isSymbolicLink()) {
      continue;
    }

    if (entryStat.isDirectory()) {
      await collectScanFiles(fullPath, files, depth + 1);
    } else if (entryStat.isFile() && entryStat.size <= MAX_SCAN_FILE_BYTES) {
      const extIdx = entry.lastIndexOf(".");
      if (extIdx !== -1 && SCANNABLE_EXTENSIONS.has(entry.slice(extIdx))) {
        files.push(fullPath);
      }
    }
  }
}

function scanContent(content: string, filePath: string, findings: ScanFinding[]): void {
  for (const { pattern, label } of CRITICAL_PATTERNS) {
    if (pattern.test(content)) {
      findings.push({ file: filePath, pattern: label, severity: "critical" });
    }
  }
  for (const { pattern, label } of WARNING_PATTERNS) {
    if (pattern.test(content)) {
      findings.push({ file: filePath, pattern: label, severity: "warning" });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a workspace's node_modules for dangerous code patterns.
 *
 * Returns an error if any critical patterns are found.
 * Returns findings (including warnings) on success for caller inspection.
 */
export async function scanWorkspaceCode(
  workspacePath: string,
  _config: DependencyConfig,
): Promise<Result<ScanResult, ForgeError>> {
  const nodeModulesPath = join(workspacePath, "node_modules");

  // Collect scannable files
  const files: string[] = [];
  await collectScanFiles(nodeModulesPath, files, 0);

  const findings: ScanFinding[] = [];

  for (const filePath of files) {
    try {
      const content = await Bun.file(filePath).text();
      const relativePath = filePath.slice(nodeModulesPath.length + 1);
      scanContent(content, relativePath, findings);
    } catch (_: unknown) {
      // Skip unreadable files
    }
  }

  // Check for critical findings — these block installation
  const criticals = findings.filter((f) => f.severity === "critical");
  if (criticals.length > 0) {
    const details = criticals
      .slice(0, 5)
      .map((f) => `  ${f.file}: ${f.pattern}`)
      .join("\n");
    return {
      ok: false,
      error: resolveError(
        "AUDIT_FAILED",
        `Dangerous code patterns found in node_modules:\n${details}`,
      ),
    };
  }

  return {
    ok: true,
    value: { findings, scannedFiles: files.length },
  };
}
