import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "check-complexity.ts");

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = join(
    tmpdir(),
    `koi-complexity-test-${String(Date.now())}-${String(Math.random()).slice(2)}`,
  );
  await mkdir(join(tmpRoot, "packages", "lib", "demo", "src"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeOneViolation(): Promise<void> {
  const lines = ["export function tooLong(): number {", "  let total = 0;"];
  for (let i = 0; i < 55; i++) {
    lines.push("  total += 1;");
  }
  lines.push("  return total;", "}");
  await writeFile(
    join(tmpRoot, "packages", "lib", "demo", "src", "index.ts"),
    `${lines.join("\n")}\n`,
  );
}

async function runCheck(args: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      KOI_COMPLEXITY_ROOT: tmpRoot,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("check-complexity ratchet", () => {
  test("--max-violations fails when violations exceed the budget", async () => {
    await writeOneViolation();
    const r = await runCheck(["--max-violations", "0"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("1 complexity violation");
    expect(r.stderr).toContain("exceeds ratchet budget of 0");
  });

  test("--max-violations allows the current budget while still reporting violations", async () => {
    await writeOneViolation();
    const r = await runCheck(["--max-violations", "1"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("1 complexity violation");
    expect(r.stderr).toContain("within ratchet budget of 1");
  });
});
