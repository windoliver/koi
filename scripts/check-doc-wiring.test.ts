import { describe, expect, test } from "bun:test";
import { packageJsonChangeRequiresDocUpdate } from "./check-doc-wiring-utils.js";

const basePackageJson = {
  name: "@koi/demo",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    },
  },
  dependencies: {
    "@koi/core": "workspace:*",
  },
  scripts: {
    build: "tsup",
    test: "bun test",
  },
};

function packageJsonWith(overrides: object): string {
  return `${JSON.stringify({ ...basePackageJson, ...overrides }, null, 2)}\n`;
}

describe("packageJsonChangeRequiresDocUpdate", () => {
  test("ignores build script runner changes", () => {
    expect(
      packageJsonChangeRequiresDocUpdate(
        packageJsonWith({}),
        packageJsonWith({
          scripts: {
            build: "bun ../../../scripts/run-tsup.ts",
            test: "bun test",
          },
        }),
      ),
    ).toBe(false);
  });

  test("flags dependency changes", () => {
    expect(
      packageJsonChangeRequiresDocUpdate(
        packageJsonWith({}),
        packageJsonWith({
          dependencies: {
            "@koi/core": "workspace:*",
            "@koi/errors": "workspace:*",
          },
        }),
      ),
    ).toBe(true);
  });

  test("flags export surface changes", () => {
    expect(
      packageJsonChangeRequiresDocUpdate(
        packageJsonWith({}),
        packageJsonWith({
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              import: "./dist/index.js",
            },
            "./extra": {
              types: "./dist/extra.d.ts",
              import: "./dist/extra.js",
            },
          },
        }),
      ),
    ).toBe(true);
  });
});
