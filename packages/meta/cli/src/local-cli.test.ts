import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScaffoldKoiCommand } from "./local-cli.js";

function makeTempDir(): string {
  return join(tmpdir(), `koi-local-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  tempDirs.length = 0;
});

describe("resolveScaffoldKoiCommand", () => {
  test("uses the local monorepo CLI when the target directory is inside the repo", () => {
    const rootDir = makeTempDir();
    const targetDir = join(rootDir, "agents", "demo-agent");
    tempDirs.push(rootDir);

    mkdirSync(join(rootDir, "packages", "meta", "cli", "dist"), { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(rootDir, "package.json"), JSON.stringify({ name: "koi" }));
    writeFileSync(
      join(rootDir, "packages", "meta", "cli", "dist", "bin.js"),
      "#!/usr/bin/env bun\n",
    );

    expect(resolveScaffoldKoiCommand(targetDir)).toBe("../../packages/meta/cli/dist/bin.js");
  });

  test("falls back to the published koi binary outside the monorepo", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    mkdirSync(dir, { recursive: true });

    expect(resolveScaffoldKoiCommand(dir)).toBe("koi");
  });
});
