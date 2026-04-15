import { afterEach, describe, expect, test } from "bun:test";
import type { CliFlags } from "./args.js";
import {
  isDeployFlags,
  isDoctorFlags,
  isInitFlags,
  isKnownCommand,
  isLogsFlags,
  isServeFlags,
  isSessionsFlags,
  isStartFlags,
  isStatusFlags,
  isStopFlags,
  isTuiFlags,
  ParseError,
  parseArgs,
} from "./args.js";

// ---------------------------------------------------------------------------
// Test helper — replaces scattered `as XxxFlags` casts with a guarded narrower
// that throws on wrong type rather than silently allowing incorrect access.
// ---------------------------------------------------------------------------

function asFlags<T extends CliFlags>(guard: (f: CliFlags) => f is T, argv: readonly string[]): T {
  const flags = parseArgs(argv);
  if (!guard(flags)) {
    throw new Error(
      `Expected ${guard.name} for argv [${argv.join(", ")}], got command=${flags.command}`,
    );
  }
  return flags;
}

describe("parseArgs", () => {
  test("returns undefined command when no args", () => {
    const result = parseArgs([]);
    expect(result.command).toBeUndefined();
    expect(result.version).toBe(false);
    expect(result.help).toBe(false);
  });

  test("detects --version", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
  });

  test("detects -V shorthand", () => {
    expect(parseArgs(["-V"]).version).toBe(true);
  });

  test("detects --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  test("detects -h shorthand", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  test("unknown command returns BaseFlags", () => {
    const result = parseArgs(["bogus"]);
    expect(result.command).toBe("bogus");
  });

  describe("init", () => {
    test("parses bare init", () => {
      const r = asFlags(isInitFlags, ["init"]);
      expect(r.command).toBe("init");
      expect(r.yes).toBe(false);
    });

    test("parses directory positional", () => {
      const r = asFlags(isInitFlags, ["init", "my-agent"]);
      expect(r.directory).toBe("my-agent");
    });

    test("parses --yes", () => {
      expect(asFlags(isInitFlags, ["init", "--yes"]).yes).toBe(true);
    });

    test("parses -y shorthand", () => {
      expect(asFlags(isInitFlags, ["init", "-y"]).yes).toBe(true);
    });

    test("parses --name", () => {
      expect(asFlags(isInitFlags, ["init", "--name", "a"]).name).toBe("a");
    });

    test("parses --template", () => {
      expect(asFlags(isInitFlags, ["init", "--template", "copilot"]).template).toBe("copilot");
    });

    test("parses --model", () => {
      expect(asFlags(isInitFlags, ["init", "--model", "gpt-4o"]).model).toBe("gpt-4o");
    });

    test("parses --engine", () => {
      expect(asFlags(isInitFlags, ["init", "--engine", "loop"]).engine).toBe("loop");
    });

    test("parses all flags together", () => {
      const r = asFlags(isInitFlags, [
        "init",
        "proj",
        "-y",
        "--name",
        "A",
        "--template",
        "t",
        "--model",
        "m",
        "--engine",
        "e",
      ]);
      expect(r.command).toBe("init");
      expect(r.directory).toBe("proj");
      expect(r.yes).toBe(true);
      expect(r.name).toBe("A");
      expect(r.template).toBe("t");
      expect(r.model).toBe("m");
      expect(r.engine).toBe("e");
    });
  });

  describe("start", () => {
    test("parses manifest positional", () => {
      const r = asFlags(isStartFlags, ["start", "./agent.yaml"]);
      expect(r.command).toBe("start");
      expect(r.manifest).toBe("./agent.yaml");
    });

    test("parses --verbose / -v", () => {
      expect(asFlags(isStartFlags, ["start", "-v"]).verbose).toBe(true);
    });

    test("parses --dry-run", () => {
      expect(asFlags(isStartFlags, ["start", "--dry-run"]).dryRun).toBe(true);
    });

    test("parses --log-format json", () => {
      expect(asFlags(isStartFlags, ["start", "--log-format", "json"]).logFormat).toBe("json");
    });

    test("defaults log-format to text", () => {
      expect(asFlags(isStartFlags, ["start"]).logFormat).toBe("text");
    });
  });

  describe("serve", () => {
    test("parses manifest", () => {
      expect(asFlags(isServeFlags, ["serve", "./a.yaml"]).manifest).toBe("./a.yaml");
    });

    test("parses --port / -p", () => {
      expect(asFlags(isServeFlags, ["serve", "-p", "8080"]).port).toBe(8080);
    });

    test("parses --verbose", () => {
      expect(asFlags(isServeFlags, ["serve", "--verbose"]).verbose).toBe(true);
    });
  });

  describe("tui", () => {
    test("parses bare tui", () => {
      const r = asFlags(isTuiFlags, ["tui"]);
      expect(r.command).toBe("tui");
      expect(r.agent).toBeUndefined();
    });

    test("parses --agent and --session", () => {
      const r = asFlags(isTuiFlags, ["tui", "--agent", "a1", "--session", "s1"]);
      expect(r.agent).toBe("a1");
      expect(r.session).toBe("s1");
    });
  });

  describe("sessions", () => {
    test("parses bare sessions", () => {
      const r = asFlags(isSessionsFlags, ["sessions"]);
      expect(r.command).toBe("sessions");
      expect(r.subcommand).toBeUndefined();
      expect(r.limit).toBe(20);
    });

    test("parses sessions list", () => {
      expect(asFlags(isSessionsFlags, ["sessions", "list"]).subcommand).toBe("list");
    });

    test("parses --limit / -n", () => {
      expect(asFlags(isSessionsFlags, ["sessions", "-n", "10"]).limit).toBe(10);
    });
  });

  describe("logs", () => {
    test("parses defaults", () => {
      const r = asFlags(isLogsFlags, ["logs"]);
      expect(r.follow).toBe(false);
      expect(r.lines).toBe(50);
    });

    test("parses --follow / -f", () => {
      expect(asFlags(isLogsFlags, ["logs", "-f"]).follow).toBe(true);
    });

    test("parses --lines / -n", () => {
      expect(asFlags(isLogsFlags, ["logs", "-n", "100"]).lines).toBe(100);
    });

    test("parses manifest positional", () => {
      expect(asFlags(isLogsFlags, ["logs", "./a.yaml"]).manifest).toBe("./a.yaml");
    });
  });

  describe("status", () => {
    test("parses bare status", () => {
      expect(asFlags(isStatusFlags, ["status"]).json).toBe(false);
    });

    test("parses --json", () => {
      expect(asFlags(isStatusFlags, ["status", "--json"]).json).toBe(true);
    });

    test("parses --timeout", () => {
      expect(asFlags(isStatusFlags, ["status", "--timeout", "5000"]).timeout).toBe(5000);
    });
  });

  describe("doctor", () => {
    test("parses bare doctor", () => {
      const r = asFlags(isDoctorFlags, ["doctor"]);
      expect(r.repair).toBe(false);
      expect(r.json).toBe(false);
    });

    test("parses --repair", () => {
      expect(asFlags(isDoctorFlags, ["doctor", "--repair"]).repair).toBe(true);
    });
  });

  describe("stop", () => {
    test("parses bare stop", () => {
      expect(asFlags(isStopFlags, ["stop"]).command).toBe("stop");
    });

    test("parses manifest", () => {
      expect(asFlags(isStopFlags, ["stop", "./a.yaml"]).manifest).toBe("./a.yaml");
    });
  });

  describe("deploy", () => {
    test("parses bare deploy", () => {
      const r = asFlags(isDeployFlags, ["deploy"]);
      expect(r.system).toBe(false);
      expect(r.uninstall).toBe(false);
    });

    test("parses --system", () => {
      expect(asFlags(isDeployFlags, ["deploy", "--system"]).system).toBe(true);
    });

    test("parses --uninstall", () => {
      expect(asFlags(isDeployFlags, ["deploy", "--uninstall"]).uninstall).toBe(true);
    });

    test("parses --port / -p", () => {
      expect(asFlags(isDeployFlags, ["deploy", "-p", "9100"]).port).toBe(9100);
    });
  });

  describe("global flags with subcommand", () => {
    test("--help flag propagates through command parse", () => {
      expect(asFlags(isStartFlags, ["start", "--help"]).help).toBe(true);
    });

    test("--version flag propagates through command parse", () => {
      expect(asFlags(isStartFlags, ["start", "--version"]).version).toBe(true);
    });

    test("-h after manifest still sets help", () => {
      expect(asFlags(isStartFlags, ["start", "./a.yaml", "-h"]).help).toBe(true);
    });

    // Regression for #1729 review: parseArgs must always return a full
    // command-specific flag shape when the command is known, even when
    // --help is present. Earlier drafts returned a minimal BaseFlags
    // shell that still narrowed through is*Flags guards, silently
    // handing callers objects missing required fields.
    test("parseArgs(start --help) returns complete StartFlags shape", () => {
      const f = asFlags(isStartFlags, ["start", "--help"]);
      expect(f.help).toBe(true);
      expect(f.mode).toBeDefined();
      expect(f.logFormat).toBe("text");
      expect(f.untilPass).toEqual([]);
      expect(typeof f.maxIter).toBe("number");
      expect(typeof f.contextWindow).toBe("number");
    });
  });

  describe("logFormat env var", () => {
    const origLogFormat = process.env.LOG_FORMAT;
    afterEach(() => {
      if (origLogFormat === undefined) {
        delete process.env.LOG_FORMAT;
      } else {
        process.env.LOG_FORMAT = origLogFormat;
      }
    });

    test("LOG_FORMAT=json is respected when no flag given", () => {
      process.env.LOG_FORMAT = "json";
      expect(asFlags(isStartFlags, ["start"]).logFormat).toBe("json");
    });

    test("--log-format flag overrides LOG_FORMAT env var", () => {
      process.env.LOG_FORMAT = "json";
      expect(asFlags(isStartFlags, ["start", "--log-format", "text"]).logFormat).toBe("text");
    });

    test("unset LOG_FORMAT defaults to text", () => {
      delete process.env.LOG_FORMAT;
      expect(asFlags(isStartFlags, ["start"]).logFormat).toBe("text");
    });
  });

  describe("type guards", () => {
    test("isInitFlags — true for init, false for others", () => {
      expect(isInitFlags(parseArgs(["init"]))).toBe(true);
      expect(isInitFlags(parseArgs(["start"]))).toBe(false);
      expect(isInitFlags(parseArgs([]))).toBe(false);
    });

    test("isStartFlags — true for start, false for others", () => {
      expect(isStartFlags(parseArgs(["start"]))).toBe(true);
      expect(isStartFlags(parseArgs(["serve"]))).toBe(false);
      expect(isStartFlags(parseArgs([]))).toBe(false);
    });

    test("isServeFlags — true for serve, false for others", () => {
      expect(isServeFlags(parseArgs(["serve"]))).toBe(true);
      expect(isServeFlags(parseArgs(["start"]))).toBe(false);
      expect(isServeFlags(parseArgs([]))).toBe(false);
    });

    test("isTuiFlags — true for tui, false for others", () => {
      expect(isTuiFlags(parseArgs(["tui"]))).toBe(true);
      expect(isTuiFlags(parseArgs(["start"]))).toBe(false);
      expect(isTuiFlags(parseArgs([]))).toBe(false);
    });

    test("isSessionsFlags — true for sessions, false for others", () => {
      expect(isSessionsFlags(parseArgs(["sessions"]))).toBe(true);
      expect(isSessionsFlags(parseArgs(["logs"]))).toBe(false);
      expect(isSessionsFlags(parseArgs([]))).toBe(false);
    });

    test("isLogsFlags — true for logs, false for others", () => {
      expect(isLogsFlags(parseArgs(["logs"]))).toBe(true);
      expect(isLogsFlags(parseArgs(["sessions"]))).toBe(false);
      expect(isLogsFlags(parseArgs([]))).toBe(false);
    });

    test("isStatusFlags — true for status, false for others", () => {
      expect(isStatusFlags(parseArgs(["status"]))).toBe(true);
      expect(isStatusFlags(parseArgs(["doctor"]))).toBe(false);
      expect(isStatusFlags(parseArgs([]))).toBe(false);
    });

    test("isDoctorFlags — true for doctor, false for others", () => {
      expect(isDoctorFlags(parseArgs(["doctor"]))).toBe(true);
      expect(isDoctorFlags(parseArgs(["status"]))).toBe(false);
      expect(isDoctorFlags(parseArgs([]))).toBe(false);
    });

    test("isStopFlags — true for stop, false for others", () => {
      expect(isStopFlags(parseArgs(["stop"]))).toBe(true);
      expect(isStopFlags(parseArgs(["deploy"]))).toBe(false);
      expect(isStopFlags(parseArgs([]))).toBe(false);
    });

    test("isDeployFlags — true for deploy, false for others", () => {
      expect(isDeployFlags(parseArgs(["deploy"]))).toBe(true);
      expect(isDeployFlags(parseArgs(["stop"]))).toBe(false);
      expect(isDeployFlags(parseArgs([]))).toBe(false);
    });

    test("all guards return false for BaseFlags", () => {
      const f = parseArgs([]);
      expect(isInitFlags(f)).toBe(false);
      expect(isStartFlags(f)).toBe(false);
      expect(isServeFlags(f)).toBe(false);
      expect(isTuiFlags(f)).toBe(false);
      expect(isSessionsFlags(f)).toBe(false);
      expect(isLogsFlags(f)).toBe(false);
      expect(isStatusFlags(f)).toBe(false);
      expect(isDoctorFlags(f)).toBe(false);
      expect(isStopFlags(f)).toBe(false);
      expect(isDeployFlags(f)).toBe(false);
    });
  });

  describe("isKnownCommand", () => {
    test("returns true for each known command", () => {
      for (const cmd of [
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
      ]) {
        expect(isKnownCommand(cmd)).toBe(true);
      }
    });

    test("returns false for unknown command", () => {
      expect(isKnownCommand("bogus")).toBe(false);
    });

    test("returns false for undefined", () => {
      expect(isKnownCommand(undefined)).toBe(false);
    });
  });

  describe("ParseError — thrown on invalid input, catchable by embedders", () => {
    // Regression: before this fix, parsers called process.exit(1) directly,
    // making it impossible for library consumers to catch validation errors.

    test("unknown flag throws ParseError (not process.exit)", () => {
      expect(() => parseArgs(["start", "--typo"])).toThrow(ParseError);
    });

    test("invalid --port value throws ParseError", () => {
      expect(() => parseArgs(["serve", "--port", "abc"])).toThrow(ParseError);
    });

    test("--port with trailing junk throws ParseError (regression: parseInt truncation)", () => {
      // Before fix: parseInt("123abc") → 123 (accepted). Now throws.
      expect(() => parseArgs(["serve", "--port", "123abc"])).toThrow(ParseError);
    });

    test("--port with scientific notation throws ParseError", () => {
      // Before fix: parseInt("1e3") → 1 (accepted). Now throws.
      expect(() => parseArgs(["serve", "--port", "1e3"])).toThrow(ParseError);
    });

    test("invalid --log-format throws ParseError", () => {
      expect(() => parseArgs(["start", "--log-format", "xml"])).toThrow(ParseError);
    });

    test("ParseError message is descriptive", () => {
      expect(() => parseArgs(["serve", "--port", "abc"])).toThrow("--port must be an integer");
    });

    test("ParseError is catchable without killing the process", () => {
      let caught: unknown;
      try {
        parseArgs(["start", "--typo"]);
      } catch (e: unknown) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ParseError);
      expect(caught instanceof ParseError && caught.message).toContain("unknown flag");
    });
  });

  describe("start — StartMode discriminated union", () => {
    test("no --prompt → mode: interactive", () => {
      const r = asFlags(isStartFlags, ["start"]);
      expect(r.mode.kind).toBe("interactive");
    });

    test("--prompt text → mode: prompt with text", () => {
      const r = asFlags(isStartFlags, ["start", "--prompt", "list files"]);
      expect(r.mode.kind).toBe("prompt");
      if (r.mode.kind === "prompt") {
        expect(r.mode.text).toBe("list files");
      }
    });

    test("-p shorthand for --prompt", () => {
      const r = asFlags(isStartFlags, ["start", "-p", "summarise"]);
      expect(r.mode.kind).toBe("prompt");
      if (r.mode.kind === "prompt") {
        expect(r.mode.text).toBe("summarise");
      }
    });

    test("--prompt with manifest", () => {
      const r = asFlags(isStartFlags, ["start", "--manifest", "a.yaml", "-p", "go"]);
      expect(r.manifest).toBe("a.yaml");
      expect(r.mode.kind).toBe("prompt");
    });

    test("--resume parses session ID", () => {
      const r = asFlags(isStartFlags, ["start", "--resume", "ses_abc123"]);
      expect(r.resume).toBe("ses_abc123");
    });

    test("no --resume → resume undefined", () => {
      expect(asFlags(isStartFlags, ["start"]).resume).toBeUndefined();
    });

    test("--no-tui sets noTui: true", () => {
      expect(asFlags(isStartFlags, ["start", "--no-tui"]).noTui).toBe(true);
    });

    test("noTui defaults to false", () => {
      expect(asFlags(isStartFlags, ["start"]).noTui).toBe(false);
    });
  });
});
