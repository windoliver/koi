#!/usr/bin/env bun
/**
 * `bun run scaffold middleware <name>` — generate a new middleware package.
 *
 * Creates a complete middleware package under packages/middleware/middleware-<name>/
 * with types, implementation, test, package.json, tsconfig, and tsup config.
 *
 * Uses the createSessionState pattern from @koi/session-state.
 *
 * Usage:
 *   bun scripts/scaffold-middleware.ts my-middleware
 *   bun scripts/scaffold-middleware.ts my-middleware --description "Short description"
 */

import { mkdir } from "node:fs/promises";

const TEMPLATES_DIR = new URL("./templates/", import.meta.url).pathname;
const PACKAGES_DIR = new URL("../packages/middleware/", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kebabToPascal(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function interpolate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

interface TemplateFile {
  readonly templateName: string;
  readonly outputPath: string;
}

function getTemplateFiles(kebabName: string): readonly TemplateFile[] {
  const base = `middleware-${kebabName}`;
  const srcDir = `${PACKAGES_DIR}${base}/src`;

  return [
    { templateName: "middleware-types.ts.template", outputPath: `${srcDir}/types.ts` },
    { templateName: "middleware-impl.ts.template", outputPath: `${srcDir}/${kebabName}.ts` },
    { templateName: "middleware-test.ts.template", outputPath: `${srcDir}/${kebabName}.test.ts` },
    { templateName: "middleware-index.ts.template", outputPath: `${srcDir}/index.ts` },
    {
      templateName: "middleware-package.json.template",
      outputPath: `${PACKAGES_DIR}${base}/package.json`,
    },
    {
      templateName: "middleware-tsconfig.json.template",
      outputPath: `${PACKAGES_DIR}${base}/tsconfig.json`,
    },
    {
      templateName: "middleware-tsup.config.ts.template",
      outputPath: `${PACKAGES_DIR}${base}/tsup.config.ts`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help") {
    console.log("Usage: bun scripts/scaffold-middleware.ts <name> [--description <desc>]");
    console.log("");
    console.log(
      "Example: bun scripts/scaffold-middleware.ts rate-limit --description 'Rate-limit model and tool calls per session'",
    );
    process.exit(0);
  }

  const rawName = args[0] ?? "";
  // Strip "middleware-" prefix if user provided it
  const kebabName = rawName.replace(/^middleware-/, "");

  if (!/^[a-z][a-z0-9-]*$/.test(kebabName)) {
    console.error(`Error: name must be lowercase kebab-case (got "${kebabName}")`);
    process.exit(1);
  }

  const descIdx = args.indexOf("--description");
  const description =
    descIdx >= 0 && args[descIdx + 1] !== undefined
      ? args[descIdx + 1]
      : `Middleware for ${kebabName.replace(/-/g, " ")}`;

  const pascalName = kebabToPascal(kebabName);
  const pkgDir = `${PACKAGES_DIR}middleware-${kebabName}`;

  // Check if package already exists
  if (await Bun.file(`${pkgDir}/package.json`).exists()) {
    console.error(`Error: package already exists at ${pkgDir}`);
    process.exit(1);
  }

  const vars: Record<string, string> = {
    KEBAB_NAME: kebabName,
    PASCAL_NAME: pascalName,
    MIDDLEWARE_NAME: kebabName,
    DESCRIPTION: description,
  };

  // Create directories
  await mkdir(`${pkgDir}/src`, { recursive: true });

  // Process templates
  const files = getTemplateFiles(kebabName);
  for (const file of files) {
    const templatePath = `${TEMPLATES_DIR}${file.templateName}`;
    const template = await Bun.file(templatePath).text();
    const content = interpolate(template, vars);
    await Bun.write(file.outputPath, content);
    console.log(`  Created ${file.outputPath.replace(PACKAGES_DIR, "packages/middleware/")}`);
  }

  console.log("");
  console.log(`Middleware package created: @koi/middleware-${kebabName}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. cd packages/middleware/middleware-${kebabName}`);
  console.log("  2. bun install");
  console.log("  3. Edit src/types.ts to define your session state");
  console.log(`  4. Edit src/${kebabName}.ts to implement your logic`);
  console.log("  5. bun test");
}

if (import.meta.main) {
  await main();
}
