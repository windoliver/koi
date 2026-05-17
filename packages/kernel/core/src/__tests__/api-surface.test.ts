/**
 * API surface stability tests for @koi/core.
 *
 * Reads every subpath export from package.json, loads the corresponding
 * .d.ts file from dist/, and snapshots it. Any unintended type signature
 * change will cause a snapshot diff.
 *
 * Requires a prior `turbo build` so dist/ is populated.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface ExportConfig {
  readonly types: string;
  readonly import: string;
}

const pkgPath = resolve(__dirname, "../../package.json");
const pkgJson = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
  readonly exports: Readonly<Record<string, ExportConfig>>;
};

const exportEntries = Object.entries(pkgJson.exports) as ReadonlyArray<
  readonly [string, ExportConfig]
>;

function normalizeImportExportSpecifiers(specifiers: string): string {
  return specifiers
    .split(",")
    .map((specifier) => specifier.trim().replace(/^[A-Za-z_$][\w$]*\s+as\s+/, "ALIAS as "))
    .join(", ");
}

function normalizeDtsSurface(dts: string): string {
  return (
    dts
      // Normalize chunk hash suffixes (e.g., "ecs-Czk0XWb5.js" -> "ecs-HASH.js").
      .replace(/([a-z-]+)-[A-Za-z0-9_-]{6,12}\.(js|d\.ts)/g, "$1-HASH.$2")
      // Bundler chunk ownership can move declarations between generated chunks
      // without changing public API. Collapse hashed chunk module names so
      // snapshots track exported names and signatures, not rollup internals.
      .replace(/from '\.\/[a-z-]+-HASH\.(js|d\.ts)'/g, "from './chunk-HASH.$1'")
      .replace(/import '\.\/[a-z-]+-HASH\.(js|d\.ts)';/g, "import './chunk-HASH.$1';")
      // Side-effect-only imports in generated .d.ts files vary by Rollup/TS
      // emit path and platform but do not change exported signatures.
      .replace(/^import '\.\/[a-z-]+\.(js|d\.ts)';\n?/gm, "")
      // Rollup-generated local symbol aliases are unstable across build paths.
      .replace(
        /\b(import|export) \{([^}]+)\} from/g,
        (match, keyword: string, specifiers: string) => {
          if (!match.includes(" as ")) {
            return match;
          }
          return `${keyword} { ${normalizeImportExportSpecifiers(specifiers)} } from`;
        },
      )
  );
}

describe("normalizeDtsSurface", () => {
  test("collapses hashed side-effect chunk imports", () => {
    expect(
      normalizeDtsSurface(
        [
          "import { TaskableAgent } from './agent-definition-AbCd1234.js';",
          "import './governance-AbCd1234.js';",
          "import './errors.js';",
        ].join("\n"),
      ),
    ).toBe(
      ["import { TaskableAgent } from './chunk-HASH.js';", "import './chunk-HASH.js';", ""].join(
        "\n",
      ),
    );
  });
});

describe("@koi/core API surface", () => {
  test("package.json has at least one export entry", () => {
    expect(exportEntries.length).toBeGreaterThan(0);
  });

  for (const [subpath, config] of exportEntries) {
    const dtsPath = resolve(__dirname, "../..", config.types);

    test(`${subpath} has stable type surface`, () => {
      const dts = readFileSync(dtsPath, "utf-8");
      const normalized = normalizeDtsSurface(dts);
      expect(normalized).toMatchSnapshot();
    });
  }
});
