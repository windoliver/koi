import { describe, expect, test } from "bun:test";
import type {
  DeployFlags,
  DoctorFlags,
  InitFlags,
  LogsFlags,
  ServeFlags,
  SessionsFlags,
  StartFlags,
  StatusFlags,
  StopFlags,
  TuiFlags,
} from "./args.js";
import {
  isDeployFlags,
  isDoctorFlags,
  isInitFlags,
  isLogsFlags,
  isServeFlags,
  isSessionsFlags,
  isStartFlags,
  isStatusFlags,
  isStopFlags,
  isTuiFlags,
  parseArgs,
} from "./args.js";

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
    expect(result.directory).toBeUndefined();
  });

  describe("init", () => {
    test("parses bare init", () => {
      const r = parseArgs(["init"]) as InitFlags;
      expect(r.command).toBe("init");
      expect(r.yes).toBe(false);
    });

    test("parses directory positional", () => {
      const r = parseArgs(["init", "my-agent"]) as InitFlags;
      expect(r.directory).toBe("my-agent");
    });

    test("parses --yes", () => {
      expect((parseArgs(["init", "--yes"]) as InitFlags).yes).toBe(true);
    });

    test("parses -y shorthand", () => {
      expect((parseArgs(["init", "-y"]) as InitFlags).yes).toBe(true);
    });

    test("parses --name", () => {
      expect((parseArgs(["init", "--name", "a"]) as InitFlags).name).toBe("a");
    });

    test("parses --template", () => {
      expect((parseArgs(["init", "--template", "copilot"]) as InitFlags).template).toBe("copilot");
    });

    test("parses --model", () => {
      expect((parseArgs(["init", "--model", "gpt-4o"]) as InitFlags).model).toBe("gpt-4o");
    });

    test("parses --engine", () => {
      expect((parseArgs(["init", "--engine", "loop"]) as InitFlags).engine).toBe("loop");
    });

    test("parses all flags together", () => {
      const r = parseArgs([
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
      ]) as InitFlags;
      expect(r.command).toBe("init");
      expect(r.directory).toBe("proj");
      expect(r.yes).toBe(true);
      expect(r.name).toBe("A");
      expect(r.template).toBe("t");
      expect(r.model).toBe("m");
      expect(r.engine).toBe("e");
    });

    test("ignores unknown flags", () => {
      expect(parseArgs(["init", "--unknown", "v"]).command).toBe("init");
    });
  });

  describe("start", () => {
    test("parses manifest positional", () => {
      const r = parseArgs(["start", "./agent.yaml"]) as StartFlags;
      expect(r.command).toBe("start");
      expect(r.manifest).toBe("./agent.yaml");
    });

    test("parses --verbose / -v", () => {
      expect((parseArgs(["start", "-v"]) as StartFlags).verbose).toBe(true);
    });

    test("parses --dry-run", () => {
      expect((parseArgs(["start", "--dry-run"]) as StartFlags).dryRun).toBe(true);
    });

    test("parses --log-format json", () => {
      expect((parseArgs(["start", "--log-format", "json"]) as StartFlags).logFormat).toBe("json");
    });

    test("defaults log-format to text", () => {
      expect((parseArgs(["start"]) as StartFlags).logFormat).toBe("text");
    });
  });

  describe("serve", () => {
    test("parses manifest", () => {
      expect((parseArgs(["serve", "./a.yaml"]) as ServeFlags).manifest).toBe("./a.yaml");
    });

    test("parses --port / -p", () => {
      expect((parseArgs(["serve", "-p", "8080"]) as ServeFlags).port).toBe(8080);
    });

    test("parses --verbose", () => {
      expect((parseArgs(["serve", "--verbose"]) as ServeFlags).verbose).toBe(true);
    });
  });

  describe("tui", () => {
    test("parses bare tui", () => {
      const r = parseArgs(["tui"]) as TuiFlags;
      expect(r.command).toBe("tui");
      expect(r.agent).toBeUndefined();
    });

    test("parses --agent and --session", () => {
      const r = parseArgs(["tui", "--agent", "a1", "--session", "s1"]) as TuiFlags;
      expect(r.agent).toBe("a1");
      expect(r.session).toBe("s1");
    });
  });

  describe("sessions", () => {
    test("parses bare sessions", () => {
      const r = parseArgs(["sessions"]) as SessionsFlags;
      expect(r.command).toBe("sessions");
      expect(r.subcommand).toBeUndefined();
      expect(r.limit).toBe(20);
    });

    test("parses sessions list", () => {
      expect((parseArgs(["sessions", "list"]) as SessionsFlags).subcommand).toBe("list");
    });

    test("parses --limit / -n", () => {
      expect((parseArgs(["sessions", "-n", "10"]) as SessionsFlags).limit).toBe(10);
    });
  });

  describe("logs", () => {
    test("parses defaults", () => {
      const r = parseArgs(["logs"]) as LogsFlags;
      expect(r.follow).toBe(false);
      expect(r.lines).toBe(50);
    });

    test("parses --follow / -f", () => {
      expect((parseArgs(["logs", "-f"]) as LogsFlags).follow).toBe(true);
    });

    test("parses --lines / -n", () => {
      expect((parseArgs(["logs", "-n", "100"]) as LogsFlags).lines).toBe(100);
    });

    test("parses manifest positional", () => {
      expect((parseArgs(["logs", "./a.yaml"]) as LogsFlags).manifest).toBe("./a.yaml");
    });
  });

  describe("status", () => {
    test("parses bare status", () => {
      expect((parseArgs(["status"]) as StatusFlags).json).toBe(false);
    });

    test("parses --json", () => {
      expect((parseArgs(["status", "--json"]) as StatusFlags).json).toBe(true);
    });

    test("parses --timeout", () => {
      expect((parseArgs(["status", "--timeout", "5000"]) as StatusFlags).timeout).toBe(5000);
    });
  });

  describe("doctor", () => {
    test("parses bare doctor", () => {
      const r = parseArgs(["doctor"]) as DoctorFlags;
      expect(r.repair).toBe(false);
      expect(r.json).toBe(false);
    });

    test("parses --repair", () => {
      expect((parseArgs(["doctor", "--repair"]) as DoctorFlags).repair).toBe(true);
    });
  });

  describe("stop", () => {
    test("parses bare stop", () => {
      expect((parseArgs(["stop"]) as StopFlags).command).toBe("stop");
    });

    test("parses manifest", () => {
      expect((parseArgs(["stop", "./a.yaml"]) as StopFlags).manifest).toBe("./a.yaml");
    });
  });

  describe("deploy", () => {
    test("parses bare deploy", () => {
      const r = parseArgs(["deploy"]) as DeployFlags;
      expect(r.system).toBe(false);
      expect(r.uninstall).toBe(false);
    });

    test("parses --system", () => {
      expect((parseArgs(["deploy", "--system"]) as DeployFlags).system).toBe(true);
    });

    test("parses --uninstall", () => {
      expect((parseArgs(["deploy", "--uninstall"]) as DeployFlags).uninstall).toBe(true);
    });

    test("parses --port / -p", () => {
      expect((parseArgs(["deploy", "-p", "9100"]) as DeployFlags).port).toBe(9100);
    });
  });

  describe("type guards", () => {
    test("isInitFlags", () => {
      expect(isInitFlags(parseArgs(["init"]))).toBe(true);
      expect(isInitFlags(parseArgs(["start"]))).toBe(false);
    });

    test("isStartFlags", () => expect(isStartFlags(parseArgs(["start"]))).toBe(true));
    test("isServeFlags", () => expect(isServeFlags(parseArgs(["serve"]))).toBe(true));
    test("isTuiFlags", () => expect(isTuiFlags(parseArgs(["tui"]))).toBe(true));
    test("isSessionsFlags", () => expect(isSessionsFlags(parseArgs(["sessions"]))).toBe(true));
    test("isLogsFlags", () => expect(isLogsFlags(parseArgs(["logs"]))).toBe(true));
    test("isStatusFlags", () => expect(isStatusFlags(parseArgs(["status"]))).toBe(true));
    test("isDoctorFlags", () => expect(isDoctorFlags(parseArgs(["doctor"]))).toBe(true));
    test("isStopFlags", () => expect(isStopFlags(parseArgs(["stop"]))).toBe(true));
    test("isDeployFlags", () => expect(isDeployFlags(parseArgs(["deploy"]))).toBe(true));

    test("all false for BaseFlags", () => {
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
});
