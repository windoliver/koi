/**
 * Cross-package naming convention lint.
 *
 * Reads all .d.ts exports from every package and validates exported
 * function names against the project's naming conventions (see CLAUDE.md).
 * Requires a prior `turbo build` so that dist/*.d.ts files exist.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ExportConfig {
  readonly types: string;
  readonly import: string;
}

interface PkgJson {
  readonly name: string;
  readonly exports?: Readonly<Record<string, ExportConfig>>;
}

/** Extract exported function names from a .d.ts file. */
function extractExportedFunctions(dts: string): readonly string[] {
  const regex = /export (?:declare )?function (\w+)/g;
  const names: string[] = [];
  // eslint-disable-next-line no-constant-condition -- intentional regex loop
  while (true) {
    const m = regex.exec(dts);
    if (m === null) break;
    const name = m[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/** Extract exported constant names from a .d.ts file. */
function extractExportedConstants(dts: string): readonly string[] {
  const regex = /export (?:declare )?const (\w+)/g;
  const names: string[] = [];
  // eslint-disable-next-line no-constant-condition -- intentional regex loop
  while (true) {
    const m = regex.exec(dts);
    if (m === null) break;
    const name = m[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface Violation {
  readonly pkg: string;
  readonly name: string;
  readonly rule: string;
}

const FUNCTION_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly rule: string;
}> = [
  { pattern: /^build[A-Z]/, rule: "Use `create*` instead of `build*` for factories" },
  { pattern: /^calculate[A-Z]/, rule: "Use `compute*` instead of `calculate*` for algorithms" },
  { pattern: /^render[A-Z]/, rule: "Use `generate*` instead of `render*` for templates" },
  { pattern: /Async$/, rule: "Remove `*Async` suffix — async is an implementation detail" },
  {
    pattern: /^validateConfig$/,
    rule: "Use `validate<Domain>Config` instead of bare `validateConfig`",
  },
];

/**
 * Check for `*To*` transform naming. We look for patterns like `fooToBar`
 * but exclude legitimate names like `toString`, type guards (`isKoiError`),
 * and names that start with `map` (which are already correct).
 */
function isTransformViolation(name: string): boolean {
  // Match camelCase with "To" followed by uppercase: e.g., "ipcErrorToKoiError"
  const match = /[a-z]To[A-Z]/.test(name);
  if (!match) return false;
  // Exclude names that already start with `map`
  if (name.startsWith("map")) return false;
  // Exclude common standard library patterns
  if (name === "toString" || name === "toJSON" || name === "toArray") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const packagesDir = resolve(__dirname, "..");
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "__tests__" && d.name !== "node_modules")
  .map((d) => d.name);

describe("naming conventions", () => {
  const violations: Violation[] = [];

  // Collect all violations first
  for (const dir of packageDirs) {
    const pkgPath = resolve(packagesDir, dir, "package.json");
    if (!existsSync(pkgPath)) continue;

    const pkgJson = JSON.parse(readFileSync(pkgPath, "utf-8")) as PkgJson;
    if (pkgJson.exports === undefined) continue;

    for (const [, config] of Object.entries(pkgJson.exports)) {
      const dtsPath = resolve(packagesDir, dir, config.types);
      if (!existsSync(dtsPath)) continue;

      const dts = readFileSync(dtsPath, "utf-8");
      const functions = extractExportedFunctions(dts);
      const constants = extractExportedConstants(dts);

      // Check function naming rules
      for (const fn of functions) {
        for (const { pattern, rule } of FUNCTION_RULES) {
          if (pattern.test(fn)) {
            violations.push({ pkg: pkgJson.name, name: fn, rule });
          }
        }
        if (isTransformViolation(fn)) {
          violations.push({
            pkg: pkgJson.name,
            name: fn,
            rule: "Use `map*` verb-first instead of `*To*` for transforms",
          });
        }
      }

      // Check constant naming (DELIVERY_DEFAULTS style → should be DEFAULT_*)
      for (const c of constants) {
        // Skip if it's already DEFAULT_* or if it's a well-known pattern
        if (c.startsWith("DEFAULT_")) continue;
        // Flag *_DEFAULTS pattern
        if (/_DEFAULTS$/.test(c)) {
          violations.push({
            pkg: pkgJson.name,
            name: c,
            rule: "Use `DEFAULT_*` prefix instead of `*_DEFAULTS` suffix",
          });
        }
      }
    }
  }

  test("no banned naming patterns in exported functions", () => {
    if (violations.length > 0) {
      const message = violations.map((v) => `  ${v.pkg}: ${v.name} — ${v.rule}`).join("\n");
      expect(violations).toEqual(expect.objectContaining({ length: 0 }));
      // This will never execute if the above fails, but provides a readable message
      throw new Error(`Naming convention violations found:\n${message}`);
    }
    expect(violations).toHaveLength(0);
  });
});
