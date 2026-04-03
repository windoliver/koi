import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeScaffold } from "./scaffold.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `koi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("writeScaffold", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      cleanup(dir);
    }
    tempDirs.length = 0;
  });

  test("writes files to target directory", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "my-agent");

    const files = {
      "koi.yaml": "name: test\n",
      "package.json": '{"name": "test"}\n',
    };

    const result = await writeScaffold(target, files);
    expect(result.ok).toBe(true);
    expect(existsSync(join(target, "koi.yaml"))).toBe(true);
    expect(existsSync(join(target, "package.json"))).toBe(true);
  });

  test("creates nested directories for file paths", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "my-agent");

    const files = {
      "src/tools/hello.ts": "export const x = 1;\n",
    };

    const result = await writeScaffold(target, files);
    expect(result.ok).toBe(true);
    expect(existsSync(join(target, "src", "tools", "hello.ts"))).toBe(true);
  });

  test("file contents are correct", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "my-agent");
    const content = "name: test-agent\nversion: 0.1.0\n";

    const result = await writeScaffold(target, { "koi.yaml": content });
    expect(result.ok).toBe(true);

    const written = await Bun.file(join(target, "koi.yaml")).text();
    expect(written).toBe(content);
  });

  test("overwrites scaffold files when target already exists with koi.yaml", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "existing");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "koi.yaml"), "name: old\n");
    writeFileSync(join(target, "keep.txt"), "keep\n");

    const result = await writeScaffold(target, { "koi.yaml": "name: new\n" });
    expect(result.ok).toBe(true);
    expect(await Bun.file(join(target, "koi.yaml")).text()).toBe("name: new\n");
    expect(await Bun.file(join(target, "keep.txt")).text()).toBe("keep\n");
  });

  test("allows writing to existing empty directory", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "empty-dir");
    mkdirSync(target, { recursive: true });

    const result = await writeScaffold(target, { "koi.yaml": "name: test\n" });
    expect(result.ok).toBe(true);
  });

  test("returns error for empty file map", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "my-agent");

    const result = await writeScaffold(target, {});
    expect(result.ok).toBe(false);
  });
});
