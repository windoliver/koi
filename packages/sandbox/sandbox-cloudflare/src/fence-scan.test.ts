import { describe, expect, it } from "bun:test";

import { scanModuleGraphForFenceViolations } from "./fence-scan.js";

describe("scanModuleGraphForFenceViolations", () => {
  it("flags a top-level fetch() call in the entry module", () => {
    const v = scanModuleGraphForFenceViolations({
      entryPath: "handler.ts",
      modules: { "handler.ts": "export default async () => fetch('https://x');" },
    });
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.target).toBe("fetch");
  });

  it("flags WebAssembly.instantiate as a member-chain target", () => {
    const v = scanModuleGraphForFenceViolations({
      entryPath: "handler.ts",
      modules: { "handler.ts": "WebAssembly.instantiate(new Uint8Array());" },
    });
    expect(v.find((x) => x.target === "WebAssembly.instantiate")).toBeDefined();
  });

  it("does NOT flag identifiers that appear only inside string literals", () => {
    const v = scanModuleGraphForFenceViolations({
      entryPath: "handler.ts",
      modules: { "handler.ts": "const msg = 'fetch is banned'; export default () => msg;" },
    });
    expect(v.length).toBe(0);
  });

  it("does NOT flag identifiers that appear only inside comments", () => {
    const v = scanModuleGraphForFenceViolations({
      entryPath: "handler.ts",
      modules: {
        "handler.ts":
          "// fetch is banned in class A\n/* caches.open */\nexport default (x) => x + 1;",
      },
    });
    expect(v.length).toBe(0);
  });

  it("walks beyond the entry module to a transitive import", () => {
    const v = scanModuleGraphForFenceViolations({
      entryPath: "handler.ts",
      modules: {
        "handler.ts": "import { go } from './lib.ts'; export default () => go();",
        "lib.ts": "export const go = () => fetch('/x');",
      },
    });
    const lib = v.find((x) => x.modulePath === "lib.ts" && x.target === "fetch");
    expect(lib).toBeDefined();
  });

  it("returns empty array for a clean class-A handler", () => {
    const v = scanModuleGraphForFenceViolations({
      entryPath: "handler.ts",
      modules: {
        "handler.ts": "export default ({ payload }) => ({ ok: true, doubled: payload.x * 2 });",
      },
    });
    expect(v).toEqual([]);
  });
});
