/**
 * TUI sandbox manifest E2E.
 *
 * These tests run the real `koi tui` CLI under `script(1)` so the child sees a
 * pseudo-terminal and reaches the TUI host's manifest gate. The manifests are
 * intentionally rejected before renderer/model setup, keeping the test fast
 * while still covering the TUI command path rather than only parser units.
 */

import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

async function hasScriptCommand(): Promise<boolean> {
  try {
    await access("/usr/bin/script");
    return true;
  } catch {
    return false;
  }
}

function stripTerminalNoise(text: string): string {
  const esc = String.fromCharCode(0x1b);
  const ansi = new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g");
  const controls = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(
      11,
    )}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(
      31,
    )}${String.fromCharCode(127)}]`,
    "g",
  );
  return text.replace(ansi, "").replace(controls, "");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runTuiWithManifest(manifest: string): Promise<{
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}> {
  const binPath = join(import.meta.dir, "..", "bin.ts");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  // Force the normal shipped TUI re-exec path. Setting this directly triggers
  // the early SIGUSR2 child-ready signal in bin.ts, which is meant only for the
  // re-exec parent and can kill a test shell.
  delete env.KOI_TUI_BROWSER_SOLID;
  const tuiCommand = [process.execPath, binPath, "tui", "--manifest", manifest];
  const scriptArgs =
    platform() === "linux"
      ? ["/usr/bin/script", "-q", "-e", "-c", tuiCommand.map(shellQuote).join(" "), "/dev/null"]
      : ["/usr/bin/script", "-q", "/dev/null", ...tuiCommand];
  const proc = Bun.spawn(scriptArgs, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    stdout: stripTerminalNoise(stdout),
    stderr: stripTerminalNoise(stderr),
  };
}

describe.skipIf(!(await hasScriptCommand()))("koi tui sandbox manifest e2e", () => {
  test.each([
    {
      name: "subprocess provider is rejected until it can enforce filesystem confinement",
      yaml: ["model:", "  name: test/model", "codeSandbox:", "  provider: subprocess"].join("\n"),
      expected: "No codeSandbox providers are currently supported",
    },
    {
      name: "unknown backend options are rejected before runtime setup",
      yaml: [
        "model:",
        "  name: test/model",
        "codeSandbox:",
        "  provider: subprocess",
        "  image: python:3.12-slim",
      ].join("\n"),
      expected: 'manifest.codeSandbox: unknown key "image"',
    },
    {
      name: "missing provider is rejected before runtime setup",
      yaml: ["model:", "  name: test/model", "codeSandbox:", "  image: python:3.12-slim"].join(
        "\n",
      ),
      expected: "manifest.codeSandbox.provider is required",
    },
  ])("$name", async ({ yaml, expected }) => {
    const dir = await mkdtemp(join(tmpdir(), "koi-tui-sandbox-e2e-"));
    try {
      const manifest = join(dir, "koi.yaml");
      await writeFile(manifest, `${yaml}\n`);

      const result = await runTuiWithManifest(manifest);

      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("koi tui: invalid manifest");
      expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
