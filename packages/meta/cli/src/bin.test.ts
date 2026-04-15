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

  describe("known commands — dispatch", () => {
    // Stub commands (Phase 2i-3) exit 2 (FAILURE) to fail closed — automation
    // must not treat a no-op stub as a successful operation.
    test("stub commands exit 2 (FAILURE)", async () => {
      for (const cmd of ["init", "serve", "logs", "status", "stop", "deploy"]) {
        const r = await runBin([cmd]);
        expect(r.exitCode).toBe(2);
        expect(r.stderr).toContain("Phase 2i-3");
      }
    });

    // start is wired — exits 2 with API key error when no key is set
    test("koi start exits 2 with no API key message", async () => {
      const r = await runBin(["start"], { OPENROUTER_API_KEY: "" });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("no API key");
    });

    test("koi tui exits 1 with TTY error outside a terminal", async () => {
      const r = await runBin(["tui"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("TTY");
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

  describe("--prompt empty value rejection", () => {
    test("--prompt '' exits 1 with error (prevents silent fallback to interactive mode)", async () => {
      const r = await runBin(["start", "--prompt", ""]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--prompt");
    });

    test("--prompt with whitespace-only exits 1", async () => {
      const r = await runBin(["start", "--prompt", "   "]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--prompt");
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

    test("--log-format json exits 2 (not yet implemented)", async () => {
      const r = await runBin(["start", "--log-format", "json"], { OPENROUTER_API_KEY: "" });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("--log-format");
    });
  });

  describe("--help with subcommand (#1729)", () => {
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

    // Regression for #1729: every subcommand must emit its own help block,
    // not the generic top-level usage. The per-command marker `koi <cmd> —`
    // only appears in help.ts, so its presence proves the dispatch help
    // branch picked the right COMMAND_HELP entry.
    const SUBCOMMANDS = [
      "init",
      "start",
      "serve",
      "tui",
      "sessions",
      "logs",
      "status",
      "doctor",
      "stop",
      "deploy",
      "plugin",
      "mcp",
    ] as const;

    for (const cmd of SUBCOMMANDS) {
      test(`\`koi ${cmd} --help\` prints per-command help`, async () => {
        const r = await runBin([cmd, "--help"]);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain(`koi ${cmd} —`);
        expect(r.stdout).toContain("Usage:");
        // Proves we are NOT falling back to the generic top-level help.
        expect(r.stdout).not.toContain("agent engine CLI");
      });
    }

    test("`koi plugin --help` does not emit subcommand-required error", async () => {
      // Regression: plugin parser throws ParseError when no subcommand is
      // given. --help must short-circuit before that throw fires.
      const r = await runBin(["plugin", "--help"]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("install");
      expect(r.stdout).toContain("list");
    });

    test("`koi mcp --help` does not emit subcommand-required error", async () => {
      const r = await runBin(["mcp", "--help"]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("auth");
    });

    test("`koi start --help` lists --prompt flag", async () => {
      const r = await runBin(["start", "--help"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("--prompt");
      expect(r.stdout).toContain("--until-pass");
    });

    // Parser/help parity: every command that accepts a positional
    // manifest in its parser must advertise that positional in its
    // help usage line. Regression for the review that caught `koi stop`
    // missing `[manifest]` in its usage text.
    const POSITIONAL_MANIFEST_COMMANDS = [
      "start",
      "serve",
      "logs",
      "status",
      "doctor",
      "stop",
      "deploy",
    ] as const;

    for (const cmd of POSITIONAL_MANIFEST_COMMANDS) {
      test(`\`koi ${cmd} --help\` usage line advertises [manifest] positional`, async () => {
        const r = await runBin([cmd, "--help"]);
        expect(r.exitCode).toBe(0);
        const usageLine = r.stdout
          .split("\n")
          .find((l) => l.includes(`koi ${cmd}`) && l.includes("[manifest]"));
        expect(usageLine).toBeDefined();
      });
    }

    test("`koi stop <manifest>` is accepted (parser parity with help)", async () => {
      // If stop's parser rejected the positional, this would exit 1
      // with "unknown flag" or similar. Stub commands exit 2.
      const r = await runBin(["stop", "./agent.yaml"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).not.toContain("unknown flag");
    });

    // Regression for #1729 review round 4: once the raw-argv fast-path
    // stopped firing for subcommand invocations, strict parsers like
    // `plugin` and `mcp` could swallow `--version` with a usage error.
    // The dispatch short-circuit must honor --version before any parser
    // runs, for every known command.
    test("`koi plugin --version` prints version and exits 0", async () => {
      const r = await runBin(["plugin", "--version"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("0.0.0");
      expect(r.stderr).toBe("");
    });

    test("`koi mcp --version` prints version and exits 0", async () => {
      const r = await runBin(["mcp", "--version"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("0.0.0");
      expect(r.stderr).toBe("");
    });

    test("`koi start --version` prints version and exits 0", async () => {
      const r = await runBin(["start", "--version"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("0.0.0");
    });

    // --version takes precedence over --help when both appear, matching
    // the order of the top-level fast-path checks in bin.ts.
    test("`koi start --version --help` prints version (version wins)", async () => {
      const r = await runBin(["start", "--version", "--help"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("0.0.0");
    });
  });

  describe("start command — new flags (Phase 2i-3)", () => {
    // Unset API key so these flag-shape tests don't make real API calls.
    const NO_KEY = { OPENROUTER_API_KEY: "" } as const;

    test("--prompt accepted as known flag (exits 2, not 1)", async () => {
      const r = await runBin(["start", "--prompt", "list files"], NO_KEY);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).not.toContain("unknown flag");
    });

    test("-p shorthand accepted for --prompt", async () => {
      const r = await runBin(["start", "-p", "go"], NO_KEY);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).not.toContain("unknown flag");
    });

    test("--resume accepted as known flag", async () => {
      const r = await runBin(["start", "--resume", "ses_abc"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).not.toContain("unknown flag");
    });

    test("--no-tui accepted as known flag", async () => {
      const r = await runBin(["start", "--no-tui"], NO_KEY);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).not.toContain("unknown flag");
    });

    test("single-prompt mode exits 2 with no API key message", async () => {
      const r = await runBin(["start", "--prompt", "list files"], {
        OPENROUTER_API_KEY: "",
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("no API key");
    });
  });
});
