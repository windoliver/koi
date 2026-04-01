#!/usr/bin/env bun
/**
 * CI enforcement — verifies that every workspace package.json has a valid `description`.
 *
 * Checks:
 * 1. Every package.json under `packages/` has a `description` field
 * 2. Description is a non-empty string
 * 3. Description is ≤120 characters
 * 4. Description doesn't start with "A " or "The " (anti-marketing heuristic)
 *
 * Also checks root package.json.
 *
 * Usage: bun scripts/check-descriptions.ts
 */

interface Violation {
  readonly pkg: string;
  readonly reason: string;
}

const ROOT = new URL("../", import.meta.url).pathname;
const MAX_LENGTH = 120;

async function collectPackageJsonPaths(): Promise<readonly string[]> {
  const paths: string[] = [];

  // Root
  paths.push(`${ROOT}package.json`);

  // Workspace packages
  const pkgGlob = new Bun.Glob("packages/*/*/package.json");
  for await (const path of pkgGlob.scan({ cwd: ROOT, absolute: true })) {
    paths.push(path);
  }

  return paths;
}

function validateDescription(name: string, description: unknown): readonly Violation[] {
  const violations: Violation[] = [];

  if (description === undefined || description === null) {
    violations.push({ pkg: name, reason: "missing 'description' field" });
    return violations;
  }

  if (typeof description !== "string") {
    violations.push({
      pkg: name,
      reason: `'description' is ${typeof description}, expected string`,
    });
    return violations;
  }

  if (description.trim().length === 0) {
    violations.push({ pkg: name, reason: "'description' is empty" });
    return violations;
  }

  if (description.length > MAX_LENGTH) {
    violations.push({
      pkg: name,
      reason: `description is ${description.length} chars (max ${MAX_LENGTH})`,
    });
  }

  if (description.startsWith("A ") || description.startsWith("The ")) {
    violations.push({
      pkg: name,
      reason: `description starts with "${description.split(" ")[0]} " — use verb-first active voice`,
    });
  }

  return violations;
}

async function main(): Promise<void> {
  const paths = await collectPackageJsonPaths();
  const allViolations: Violation[] = [];
  let checked = 0;

  const results = await Promise.all(
    paths.map(async (pkgPath) => {
      try {
        const parsed = (await Bun.file(pkgPath).json()) as {
          readonly name?: string;
          readonly description?: unknown;
        };
        const name = parsed.name ?? pkgPath;
        return validateDescription(name, parsed.description);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return [{ pkg: pkgPath, reason: `failed to read: ${msg}` }] as const;
      }
    }),
  );

  for (const violations of results) {
    checked++;
    for (const v of violations) {
      allViolations.push(v);
    }
  }

  if (allViolations.length > 0) {
    console.log(`\n${allViolations.length} description violation(s) found:\n`);
    for (const v of allViolations) {
      console.log(`  ✗ ${v.pkg}: ${v.reason}`);
    }
    console.log("");
    process.exit(1);
  }

  console.log(`All ${checked} package.json files have valid descriptions.`);
}

await main();
