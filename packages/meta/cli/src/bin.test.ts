import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const BIN = join(import.meta.dir, "bin.ts");

async function runBin(
  args: readonly string[],
  extraEnv?: Readonly<Record<string, string>>,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
  const proc = Bun.spawn(
    ["bun", BIN, ...args],
    extraEnv !== undefined
      ? {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...(process.env as Record<string, string>), ...extraEnv },
        }
      : { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("bin.ts", () => {
  describe("fast-path flags (no module loading)", () => {
    test("--version prints version and exits 0", async () => {
      const r = await runBin(["--version"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("0.0.0");
    });

    test("-V shorthand exits 0 with version", async () => {
      const r = await runBin(["-V"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("0.0.0");
    });

    test("--help prints usage and exits 0", async () => {
      const r = await runBin(["--help"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("koi");
      expect(r.stdout).toContain("init");
      expect(r.stdout).toContain("start");
      expect(r.stdout).toContain("--version");
      expect(r.stdout).toContain("--help");
    });

    test("-h shorthand exits 0 with help", async () => {
      const r = await runBin(["-h"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("koi");
    });
  });

  describe("no args / help fallback", () => {
    test("no args prints help and exits 0", async () => {
      const r = await runBin([]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("koi");
      expect(r.stdout).toContain("init");
    });
  });

  describe("known commands (not yet implemented)", () => {
    test("known command prints not-yet-implemented and exits 1", async () => {
      const r = await runBin(["start"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("start");
      expect(r.stderr).toContain("not yet implemented");
    });

    test("all known commands exit 1 with not-yet-implemented", async () => {
      for (const cmd of [
        "init",
        "serve",
        "tui",
        "sessions",
        "logs",
        "status",
        "doctor",
        "stop",
        "deploy",
      ]) {
        const r = await runBin([cmd]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("not yet implemented");
      }
    });
  });

  describe("unknown commands", () => {
    test("unknown command exits 1 with error message naming the command", async () => {
      const r = await runBin(["boguscommand"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Unknown command");
      expect(r.stderr).toContain("boguscommand");
    });

    test("unknown command lists available commands", async () => {
      const r = await runBin(["boguscommand"]);
      expect(r.stderr).toContain("start");
      expect(r.stderr).toContain("init");
      expect(r.stderr).toContain("deploy");
    });
  });

  describe("unknown flag rejection", () => {
    test("unknown flag for known command exits 1 with error", async () => {
      const r = await runBin(["start", "--typo"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("unknown flag");
      expect(r.stderr).toContain("typo");
    });

    test("unknown flag includes command name in error", async () => {
      const r = await runBin(["serve", "--nope"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("koi serve");
    });
  });

  describe("numeric flag validation", () => {
    test("--port with non-numeric string exits 1", async () => {
      const r = await runBin(["serve", "--port", "abc"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--port");
    });

    test("--port out of range (> 65535) exits 1", async () => {
      const r = await runBin(["serve", "--port", "65536"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--port");
    });

    test("--port 0 exits 1 (ports start at 1)", async () => {
      const r = await runBin(["serve", "--port", "0"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--port");
    });

    test("--lines 0 exits 1", async () => {
      const r = await runBin(["logs", "--lines", "0"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--lines");
    });

    test("--lines non-numeric exits 1", async () => {
      const r = await runBin(["logs", "--lines", "abc"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--lines");
    });

    test("--limit 0 exits 1", async () => {
      const r = await runBin(["sessions", "--limit", "0"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--limit");
    });

    test("--timeout non-numeric exits 1", async () => {
      const r = await runBin(["status", "--timeout", "abc"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--timeout");
    });

    test("deploy --port out of range exits 1", async () => {
      const r = await runBin(["deploy", "--port", "99999"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--port");
    });

    // Regression: parseInt("123abc") silently returned 123 before full-string validation
    test("--port with trailing junk (e.g. '123abc') exits 1, not port 123", async () => {
      const r = await runBin(["serve", "--port", "123abc"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--port");
    });

    test("--port with scientific notation (e.g. '1e3') exits 1", async () => {
      const r = await runBin(["serve", "--port", "1e3"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--port");
    });

    test("--lines with trailing junk (e.g. '50foo') exits 1", async () => {
      const r = await runBin(["logs", "--lines", "50foo"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--lines");
    });
  });

  describe("--log-format validation", () => {
    test("invalid --log-format exits 1 with error", async () => {
      const r = await runBin(["start", "--log-format", "xml"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--log-format");
      expect(r.stderr).toContain("xml");
    });

    test("LOG_FORMAT env var with invalid value exits 1", async () => {
      const r = await runBin(["start"], { LOG_FORMAT: "xml" });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--log-format");
    });
  });

  describe("--help with subcommand", () => {
    test("command --help prints help and exits 0", async () => {
      const r = await runBin(["start", "--help"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("koi");
    });

    test("command -h prints help and exits 0", async () => {
      const r = await runBin(["serve", "-h"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("koi");
    });
  });
});
