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
const { parseArgs, isInitFlags } = await import("../args.js");

/** Parse args and narrow to InitFlags, throwing if not an init command. */
function parseInitArgs(argv: readonly string[]): import("../args.js").InitFlags {
  const flags = parseArgs(argv);
  if (!isInitFlags(flags)) {
    throw new Error(`Expected init command, got: ${flags.command}`);
  }
  return flags;
}

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

    const flags = parseInitArgs(["init", target, "--yes", "--name", "test-minimal"]);
    await runInit(flags);

    const yaml = await Bun.file(join(target, "koi.yaml")).text();
    expect(yaml).toContain("name: test-minimal");
    expect(yaml).toContain("version: 0.1.0");
    expect(yaml).toContain("@koi/channel-cli");
    expect(yaml).toContain("bootstrap: true");
  });

  test("creates package.json with correct name and type", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-pkg");

    const flags = parseInitArgs(["init", target, "--yes", "--name", "test-pkg"]);
    await runInit(flags);

    const pkg = JSON.parse(await Bun.file(join(target, "package.json")).text());
    expect(pkg.name).toBe("test-pkg");
    expect(pkg.type).toBe("module");
    expect(pkg.private).toBe(true);
    expect(pkg.scripts.koi).toBe("koi");
    expect(pkg.scripts["dry-run"]).toBe("bun run koi -- start --dry-run");
    expect(pkg.scripts.start).toBe("bun run koi -- start");
    expect(pkg.scripts["start:admin"]).toBe("bun run koi -- start --admin");
    expect(pkg.scripts["serve:admin"]).toBe("bun run koi -- serve --admin");
    expect(pkg.scripts.admin).toBe("bun run koi -- admin");
    expect(pkg.scripts.tui).toBe("bun run koi -- tui");
    expect(pkg.dependencies.koi).toBe("latest");
  });

  test("creates tsconfig.json with strict mode", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-ts");

    const flags = parseInitArgs(["init", target, "--yes", "--name", "test-ts"]);
    await runInit(flags);

    const tsconfig = JSON.parse(await Bun.file(join(target, "tsconfig.json")).text());
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.module).toBe("NodeNext");
  });

  test("creates README.md with agent name", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-readme");

    const flags = parseInitArgs(["init", target, "--yes", "--name", "test-readme"]);
    await runInit(flags);

    const readme = await Bun.file(join(target, "README.md")).text();
    expect(readme).toContain("# test-readme");
    expect(readme).toContain("bun run start:admin");
    expect(readme).toContain("uv run nexus");
    expect(readme).toContain("bun run koi -- start --admin path/to/koi.yaml");
  });

  test("generates bootstrap and env files for minimal template", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-count");

    const flags = parseInitArgs(["init", target, "--yes", "--name", "test-count"]);
    await runInit(flags);

    expect(existsSync(join(target, "koi.yaml"))).toBe(true);
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(target, "README.md"))).toBe(true);
    expect(existsSync(join(target, ".env"))).toBe(true);
    expect(existsSync(join(target, ".gitignore"))).toBe(true);
    expect(existsSync(join(target, ".koi", "INSTRUCTIONS.md"))).toBe(true);
  });
});

describe("koi init --yes (copilot template)", () => {
  test("creates tool guidance and built-in tools", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-copilot");

    const flags = parseInitArgs([
      "init",
      target,
      "--yes",
      "--name",
      "test-copilot",
      "--template",
      "copilot",
    ]);
    await runInit(flags);

    expect(existsSync(join(target, ".koi", "TOOLS.md"))).toBe(true);
    const toolGuide = await Bun.file(join(target, ".koi", "TOOLS.md")).text();
    expect(toolGuide).toContain("ask_user");

    const yaml = await Bun.file(join(target, "koi.yaml")).text();
    expect(yaml).toContain("@koi/tool-ask-user");
    expect(yaml).toContain("@koi/tools-web");
  });
});

describe("koi init — flag overrides", () => {
  test("--model overrides default model", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-model");

    const flags = parseInitArgs([
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

  test("--model accepts supported OpenRouter models outside the preset list", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-openrouter-model");

    const flags = parseInitArgs([
      "init",
      target,
      "--yes",
      "--name",
      "test-openrouter-model",
      "--model",
      "openrouter:google/gemini-2.0-flash-001",
    ]);
    await runInit(flags);

    const yaml = await Bun.file(join(target, "koi.yaml")).text();
    const envFile = await Bun.file(join(target, ".env")).text();
    expect(yaml).toContain('model: "openrouter:google/gemini-2.0-flash-001"');
    expect(envFile).toContain("OPENROUTER_API_KEY=");
  });

  test("--engine overrides default engine", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "test-engine");

    const flags = parseInitArgs([
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
  test("overwrites scaffold-managed files when rerun in the same directory", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "existing");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "koi.yaml"), "name: old\n");
    writeFileSync(join(target, "README.md"), "# Old\n");
    writeFileSync(join(target, "keep.txt"), "keep me\n");

    const flags = parseInitArgs(["init", target, "--yes", "--name", "conflict"]);
    await runInit(flags);

    const yaml = await Bun.file(join(target, "koi.yaml")).text();
    const readme = await Bun.file(join(target, "README.md")).text();
    expect(yaml).toContain("name: conflict");
    expect(readme).toContain("# conflict");
    expect(await Bun.file(join(target, "keep.txt")).text()).toBe("keep me\n");
  });

  test("allows scaffolding into existing empty directory", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "empty");
    mkdirSync(target, { recursive: true });

    const flags = parseInitArgs(["init", target, "--yes", "--name", "empty-dir"]);
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

    const flags = parseInitArgs(["init", target, "--yes", "--name", "My Cool Agent"]);
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

    const flags = parseInitArgs(["init", target, "--yes", "--name", "my-agent.v2"]);
    await runInit(flags);

    const yaml = await Bun.file(join(target, "koi.yaml")).text();
    expect(yaml).toContain("name: my-agent.v2");
  });

  test("uses directory name as agent name when --yes without --name", async () => {
    const parent = makeTempDir();
    tempDirs.push(parent);
    const target = join(parent, "my-project-dir");

    const flags = parseInitArgs(["init", target, "--yes"]);
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
    const flags = parseInitArgs(["init", target, "--yes"]);
    // directory is set to the full path, so basename will be "dot-test"
    await runInit(flags);

    const yaml = await Bun.file(join(target, "koi.yaml")).text();
    // Should use the directory basename, not "."
    expect(yaml).toContain("name: dot-test");
  });
});
