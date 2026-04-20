import { describe, expect, test } from "bun:test";

import { detectNodeBinary, isSupportedNodeVersion, parseNodeVersion } from "../node-detect.js";

function makeExec(
  impl: (file: string, args: readonly string[]) => string,
): typeof import("node:child_process").execFileSync {
  return impl as unknown as typeof import("node:child_process").execFileSync;
}

function makeRealpathSync(impl: (path: string) => string): typeof import("node:fs").realpathSync {
  const fn = impl as ((path: string) => string) & {
    native?: typeof import("node:fs").realpathSync.native;
  };
  fn.native = ((path: string) => impl(path)) as typeof import("node:fs").realpathSync.native;
  return fn as typeof import("node:fs").realpathSync;
}

describe("node-detect", () => {
  test("parses semver output from node --version", () => {
    expect(parseNodeVersion("v20.11.1")).toEqual({ major: 20, minor: 11, patch: 1 });
  });

  test("accepts Node.js 20.11+", () => {
    expect(isSupportedNodeVersion({ major: 20, minor: 11, patch: 0 })).toBe(true);
    expect(isSupportedNodeVersion({ major: 22, minor: 0, patch: 0 })).toBe(true);
  });

  test("rejects Node.js versions below 20.11", () => {
    expect(isSupportedNodeVersion({ major: 20, minor: 10, patch: 9 })).toBe(false);
  });

  test("detectNodeBinary resolves an absolute path and validated version", () => {
    const detected = detectNodeBinary({
      execFileSync: makeExec((file: string, args: readonly string[]) => {
        if (file === "node" && args[0] === "--version") {
          return "v20.11.1\n";
        }
        if (file === "which" && args[0] === "node") {
          return "/opt/homebrew/bin/node\n";
        }
        throw new Error(`unexpected exec ${file} ${args.join(" ")}`);
      }),
      existsSync: () => true,
      realpathSync: makeRealpathSync((path: string) => path),
    });

    expect(detected).toEqual({
      executablePath: "/opt/homebrew/bin/node",
      version: "v20.11.1",
      parsedVersion: { major: 20, minor: 11, patch: 1 },
    });
  });

  test("detectNodeBinary fails hard when node is too old", () => {
    expect(() =>
      detectNodeBinary({
        execFileSync: makeExec((file: string, args: readonly string[]) => {
          if (file === "node" && args[0] === "--version") {
            return "v20.10.0\n";
          }
          if (file === "which" && args[0] === "node") {
            return "/usr/local/bin/node\n";
          }
          throw new Error("unexpected");
        }),
        existsSync: () => true,
        realpathSync: makeRealpathSync((path: string) => path),
      }),
    ).toThrow(/requires Node\.js >= 20\.11\.0/);
  });
});
