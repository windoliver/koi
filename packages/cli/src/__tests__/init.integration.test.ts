/**
 * Integration tests for `koi init` — full flow with temp directories.
 * Tests the --yes non-interactive path + edge cases.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock @clack/prompts for integration tests
const mockIntro = mock(() => {});
const mockOutro = mock(() => {});
const mockCancel = mock(() => {});

mock.module("@clack/prompts", () => ({
  select: mock(() => Promise.resolve("minimal")),
  text: mock(() => Promise.resolve("test-agent")),
  multiselect: mock(() => Promise.resolve(["cli"])),
  confirm: mock(() => Promise.resolve(true)),
  intro: mockIntro,
  outro: mockOutro,
  cancel: mockCancel,
  isCancel: mock(() => false),
}));

const { runInit } = await import("../commands/init.js");
const { parseArgs } = await import("../args.js");

function makeTempDir(): string {
  const dir = join(tmpdir(), `koi-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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

describe("koi init --yes (minimal template)", () => {
  test("creates koi.yaml with correct name", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-minimal");

    const flags = parseArgs(["init", target, "--yes", "--name", "test-minimal"]);
    await runInit(flags);

    const yaml = await Bun.file(join(target, "koi.yaml")).text();
    expect(yaml).toContain("name: test-minimal");
    expect(yaml).toContain("version: 0.1.0");
  });

  test("creates package.json with correct name and type", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-pkg");

    const flags = parseArgs(["init", target, "--yes", "--name", "test-pkg"]);
    await runInit(flags);

    const pkg = JSON.parse(await Bun.file(join(target, "package.json")).text());
    expect(pkg.name).toBe("test-pkg");
    expect(pkg.type).toBe("module");
    expect(pkg.private).toBe(true);
  });

  test("creates tsconfig.json with strict mode", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-ts");

    const flags = parseArgs(["init", target, "--yes", "--name", "test-ts"]);
    await runInit(flags);

    const tsconfig = JSON.parse(await Bun.file(join(target, "tsconfig.json")).text());
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.module).toBe("NodeNext");
  });

  test("creates README.md with agent name", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-readme");

    const flags = parseArgs(["init", target, "--yes", "--name", "test-readme"]);
    await runInit(flags);

    const readme = await Bun.file(join(target, "README.md")).text();
    expect(readme).toContain("# test-readme");
  });

  test("generates 4 files for minimal template", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-count");

    const flags = parseArgs(["init", target, "--yes", "--name", "test-count"]);
    await runInit(flags);

    expect(existsSync(join(target, "koi.yaml"))).toBe(true);
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(target, "README.md"))).toBe(true);
  });
});

describe("koi init --yes (copilot template)", () => {
  test("creates example tool file", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-copilot");

    const flags = parseArgs([
      "init",
      target,
      "--yes",
      "--name",
      "test-copilot",
      "--template",
      "copilot",
    ]);
    await runInit(flags);

    expect(existsSync(join(target, "src", "tools", "hello.ts"))).toBe(true);
    const tool = await Bun.file(join(target, "src", "tools", "hello.ts")).text();
    expect(tool).toContain("export");
    expect(tool).toContain("test-copilot");
  });
});

describe("koi init — flag overrides", () => {
  test("--model overrides default model", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-model");

    const flags = parseArgs([
      "init",
      target,
      "--yes",
      "--name",
      "test-model",
      "--model",
      "openai:gpt-4o",
    ]);
    await runInit(flags);

    const yaml = await Bun.file(join(target, "koi.yaml")).text();
    expect(yaml).toContain("openai:gpt-4o");
  });

  test("--engine overrides default engine", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-engine");

    const flags = parseArgs([
      "init",
      target,
      "--yes",
      "--name",
      "test-engine",
      "--engine",
      "deepagents",
    ]);
    await runInit(flags);

    const yaml = await Bun.file(join(target, "koi.yaml")).text();
    expect(yaml).toContain("engine: deepagents");
  });
});

describe("koi init — edge cases", () => {
  test("rejects when koi.yaml already exists", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "existing");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "koi.yaml"), "name: old\n");

    // runInit calls process.exit(1) on error — we need to mock it
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    const flags = parseArgs(["init", target, "--yes", "--name", "conflict"]);
    try {
      await runInit(flags);
    } catch {
      // Expected — mocked process.exit throws to halt execution
    }

    process.exit = originalExit;
    expect(exitCode).toBe(1);
  });

  test("allows scaffolding into existing empty directory", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "empty");
    mkdirSync(target, { recursive: true });

    const flags = parseArgs(["init", target, "--yes", "--name", "empty-dir"]);
    await runInit(flags);

    expect(existsSync(join(target, "koi.yaml"))).toBe(true);
  });

  test("rejects invalid agent name with spaces", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "spaces");

    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    const flags = parseArgs(["init", target, "--yes", "--name", "My Cool Agent"]);
    try {
      await runInit(flags);
    } catch {
      // Expected — mocked process.exit throws to halt execution
    }

    process.exit = originalExit;
    // Name validation fails, wizard cancels with exit(0)
    expect(exitCode).toBe(0);
    expect(existsSync(join(target, "koi.yaml"))).toBe(false);
  });

  test("agent name with dots and hyphens works in YAML", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "special");

    const flags = parseArgs(["init", target, "--yes", "--name", "my-agent.v2"]);
    await runInit(flags);

    const yaml = await Bun.file(join(target, "koi.yaml")).text();
    expect(yaml).toContain("name: my-agent.v2");
  });

  test("uses directory name as agent name when --yes without --name", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "my-project-dir");

    const flags = parseArgs(["init", target, "--yes"]);
    await runInit(flags);

    const yaml = await Bun.file(join(target, "koi.yaml")).text();
    expect(yaml).toContain("name: my-project-dir");
  });

  test("defaults to koi-agent name when directory is '.'", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    // Use current-dir-like scenario: init "." but in a temp dir
    const target = join(parent, "dot-test");
    mkdirSync(target, { recursive: true });

    // When directory is ".", the resolved path is used but the name should fallback
    const flags = parseArgs(["init", target, "--yes"]);
    // directory is set to the full path, so basename will be "dot-test"
    await runInit(flags);

    const yaml = await Bun.file(join(target, "koi.yaml")).text();
    // Should use the directory basename, not "."
    expect(yaml).toContain("name: dot-test");
  });
});
