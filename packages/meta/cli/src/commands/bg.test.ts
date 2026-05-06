import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundSessionRecord } from "@koi/core";
import { agentId, workerId } from "@koi/core";
import { parseBgFlags } from "../args/bg.js";
import { ExitCode } from "../types.js";
import { defaultRegistryDir, run } from "./bg.js";

let dir: string;
let savedTmuxEnv: string | undefined;
let savedAttachedBackendEnv: string | undefined;
let savedAttachedWorkerEnv: string | undefined;
let savedAttachedSessionEnv: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "koi-bg-test-"));
  savedTmuxEnv = process.env.TMUX;
  savedAttachedBackendEnv = process.env.KOI_BG_ATTACHED_BACKEND;
  savedAttachedWorkerEnv = process.env.KOI_BG_ATTACHED_WORKER_ID;
  savedAttachedSessionEnv = process.env.KOI_BG_ATTACHED_SESSION_NAME;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (savedTmuxEnv === undefined) delete process.env.TMUX;
  else process.env.TMUX = savedTmuxEnv;
  if (savedAttachedBackendEnv === undefined) delete process.env.KOI_BG_ATTACHED_BACKEND;
  else process.env.KOI_BG_ATTACHED_BACKEND = savedAttachedBackendEnv;
  if (savedAttachedWorkerEnv === undefined) delete process.env.KOI_BG_ATTACHED_WORKER_ID;
  else process.env.KOI_BG_ATTACHED_WORKER_ID = savedAttachedWorkerEnv;
  if (savedAttachedSessionEnv === undefined) delete process.env.KOI_BG_ATTACHED_SESSION_NAME;
  else process.env.KOI_BG_ATTACHED_SESSION_NAME = savedAttachedSessionEnv;
});

async function writeSession(
  registryDir: string,
  overrides: Partial<BackgroundSessionRecord> = {},
): Promise<BackgroundSessionRecord> {
  const record: BackgroundSessionRecord = {
    workerId: workerId("w-1"),
    agentId: agentId("researcher"),
    pid: 1234,
    status: "running",
    startedAt: Date.now() - 60_000,
    logPath: join(registryDir, "..", "logs", "w-1.log"),
    command: ["bun", "run", "worker.ts"],
    backendKind: "subprocess",
    ...overrides,
  };
  await writeFile(join(registryDir, `${record.workerId}.json`), JSON.stringify(record), "utf8");
  return record;
}

function makeSpawnResult(
  code: number,
  stdout: string = "",
  stderr: string = "",
): ReturnType<typeof Bun.spawn> {
  return {
    exited: Promise.resolve(code),
    stdout: new Blob([stdout]).stream(),
    stderr: new Blob([stderr]).stream(),
  } as ReturnType<typeof Bun.spawn>;
}

function withMockedPsFingerprint(
  fingerprint: string,
): (
  argv: string[],
  options?: Bun.SpawnOptions.OptionsObject<
    string,
    Bun.SpawnOptions.Writable,
    Bun.SpawnOptions.Readable
  >,
) => ReturnType<typeof Bun.spawn> {
  const realSpawn = Bun.spawn;
  return (
    argv: string[],
    options?: Bun.SpawnOptions.OptionsObject<
      string,
      Bun.SpawnOptions.Writable,
      Bun.SpawnOptions.Readable
    >,
  ) => {
    if (argv[0] === "ps" && argv[1] === "-p") {
      return makeSpawnResult(0, `${fingerprint}\n`);
    }
    return realSpawn(argv, options);
  };
}

describe("parseBgFlags", () => {
  it("parses the ps subcommand", () => {
    const flags = parseBgFlags(["ps", "--json"]);
    expect(flags.subcommand).toBe("ps");
    expect(flags.json).toBe(true);
    expect(flags.workerId).toBeUndefined();
  });

  it("parses kill with a worker id", () => {
    const flags = parseBgFlags(["kill", "w-42"]);
    expect(flags.subcommand).toBe("kill");
    expect(flags.workerId).toBe("w-42");
  });

  it("parses logs --follow", () => {
    const flags = parseBgFlags(["logs", "w-1", "-f"]);
    expect(flags.subcommand).toBe("logs");
    expect(flags.follow).toBe(true);
  });

  it("rejects unknown subcommand", () => {
    expect(() => parseBgFlags(["ponder"])).toThrow(/subcommand/);
  });

  it("rejects missing worker id for kill/logs/attach", () => {
    for (const sub of ["kill", "logs", "attach"] as const) {
      expect(() => parseBgFlags([sub])).toThrow(/worker id/);
    }
  });

  it("accepts detach without a worker id (subprocess backend has no session)", () => {
    expect(() => parseBgFlags(["detach"])).not.toThrow();
  });

  it("defers subcommand validation under --help", () => {
    const flags = parseBgFlags(["--help"]);
    expect(flags.help).toBe(true);
    expect(flags.subcommand).toBeUndefined();
  });

  it("defaults --all to false and accepts the flag on ps", () => {
    expect(parseBgFlags(["ps"]).all).toBe(false);
    expect(parseBgFlags(["ps", "--all"]).all).toBe(true);
  });
});

describe("defaultRegistryDir", () => {
  it("honors KOI_STATE_DIR", () => {
    const original = process.env.KOI_STATE_DIR;
    process.env.KOI_STATE_DIR = "/tmp/koi-state";
    try {
      expect(defaultRegistryDir()).toBe("/tmp/koi-state/daemon/sessions");
    } finally {
      if (original === undefined) delete process.env.KOI_STATE_DIR;
      else process.env.KOI_STATE_DIR = original;
    }
  });

  it("falls back to ~/.koi/daemon/sessions when KOI_STATE_DIR is unset", () => {
    const original = process.env.KOI_STATE_DIR;
    delete process.env.KOI_STATE_DIR;
    try {
      expect(defaultRegistryDir()).toMatch(/\.koi\/daemon\/sessions$/);
    } finally {
      if (original !== undefined) process.env.KOI_STATE_DIR = original;
    }
  });
});

describe("bg ps", () => {
  it("reports empty when no sessions", async () => {
    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    try {
      const code = await run(parseBgFlags(["ps", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.OK);
      expect(writes.join("")).toContain("No background sessions");
    } finally {
      spy.mockRestore();
    }
  });

  it("emits JSON when --json is set", async () => {
    await writeSession(dir);
    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    try {
      const code = await run(parseBgFlags(["ps", "--json", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.OK);
      const output = writes.join("");
      const parsed: unknown = JSON.parse(output);
      expect(parsed).toHaveProperty("ok", true);
    } finally {
      spy.mockRestore();
    }
  });

  it("renders a table in text mode", async () => {
    await writeSession(dir, { workerId: workerId("w-research"), agentId: agentId("researcher") });
    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    try {
      await run(parseBgFlags(["ps", "--registry-dir", dir]));
      const joined = writes.join("");
      expect(joined).toContain("WORKER");
      expect(joined).toContain("w-research");
      expect(joined).toContain("researcher");
    } finally {
      spy.mockRestore();
    }
  });

  // D7: default ps view hides terminal entries older than 24h so operators
  // scanning for live work aren't buried in yesterday's crashes. `--all`
  // restores the unfiltered list for post-mortems.
  it("hides terminal records older than 24h by default, shows them with --all", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const staleEnded = Date.now() - 25 * 60 * 60 * 1000;
    const freshEnded = Date.now() - 60_000;
    await writeSession(dir, {
      workerId: workerId("w-stale"),
      status: "exited",
      startedAt: staleEnded - 60_000,
      endedAt: staleEnded,
      exitCode: 0,
    });
    await writeSession(dir, {
      workerId: workerId("w-fresh"),
      status: "exited",
      startedAt: freshEnded - 60_000,
      endedAt: freshEnded,
      exitCode: 0,
    });

    const captureJson = async (args: readonly string[]): Promise<string> => {
      const writes: string[] = [];
      const spy = spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
        writes.push(String(c));
        return true;
      });
      try {
        await run(parseBgFlags([...args, "--registry-dir", dir]));
        return writes.join("");
      } finally {
        spy.mockRestore();
      }
    };

    const defaultView = await captureJson(["ps", "--json"]);
    expect(defaultView).toContain("w-fresh");
    expect(defaultView).not.toContain("w-stale");

    const allView = await captureJson(["ps", "--json", "--all"]);
    expect(allView).toContain("w-fresh");
    expect(allView).toContain("w-stale");

    // Hint to the linter that `dayMs` is load-bearing.
    expect(dayMs).toBe(24 * 60 * 60 * 1000);
  });
});

describe("bg logs", () => {
  it("reports missing session", async () => {
    const stderr: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });
    try {
      const code = await run(parseBgFlags(["logs", "nonexistent", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.FAILURE);
      expect(stderr.join("")).toContain("No such session");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports a session with no log capture", async () => {
    await writeSession(dir, { logPath: "" });
    const stderr: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });
    try {
      const code = await run(parseBgFlags(["logs", "w-1", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.FAILURE);
      expect(stderr.join("")).toContain("no log capture");
    } finally {
      spy.mockRestore();
    }
  });

  it("streams existing log contents", async () => {
    const logPath = join(dir, "w-1.log");
    await writeFile(logPath, "line one\nline two\n", "utf8");
    await writeSession(dir, { logPath });
    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    try {
      const code = await run(parseBgFlags(["logs", "w-1", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.OK);
      expect(writes.join("")).toContain("line one");
      expect(writes.join("")).toContain("line two");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("bg kill", () => {
  it("no-ops on an already-exited session", async () => {
    await writeSession(dir, { status: "exited", endedAt: Date.now(), exitCode: 0 });
    const stderr: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });
    try {
      const code = await run(parseBgFlags(["kill", "w-1", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.OK);
      expect(stderr.join("")).toContain("already exited");
    } finally {
      spy.mockRestore();
    }
  });

  // Timeout is bumped because `bg kill` runs an 8-second respawn-detection
  // poll after finalize; the subprocess exits quickly but the CLI waits
  // its bounded poll window.
  it("terminates a live subprocess and marks it exited", async () => {
    // Spawn a long-running child we can legitimately kill.
    const proc = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 60_000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(
      withMockedPsFingerprint("Mon Jan  1 00:00:00 2024"),
    );
    try {
      await writeSession(dir, {
        workerId: workerId("w-live"),
        pid: proc.pid,
      });
      const writes: string[] = [];
      const spy = spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
        writes.push(String(c));
        return true;
      });
      try {
        const code = await run(parseBgFlags(["kill", "w-live", "--registry-dir", dir]));
        expect(code).toBe(ExitCode.OK);
        expect(writes.join("")).toContain("terminated");
      } finally {
        spy.mockRestore();
      }
      await proc.exited;

      const text = await Bun.file(join(dir, "w-live.json")).text();
      const record = JSON.parse(text) as BackgroundSessionRecord;
      expect(record.status).toBe("exited");
      expect(record.endedAt).toBeGreaterThan(0);
    } finally {
      spawnSpy.mockRestore();
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
  }, 15_000);

  // Resumed-kill path: if the record is already `terminating` with a
  // fresh `signaledAt` (e.g. operator ran `bg kill` twice; first call
  // stamped but crashed before finalize), the second call's claim
  // must NOT clear that stamp. Otherwise a crash landing between this
  // claim and the re-stamp would be misclassified as `crashed` even
  // though the original kill's signal is the proximate cause.
  it("resumed kill preserves a fresh pre-existing signaledAt stamp", async () => {
    // Mock `process.kill` to throw ESRCH for any pid/signal combo. This
    // decouples the test from host PID state: `sendSignal` translates
    // ESRCH to `{kind: "gone"}` (no stamp) and `isProcessAlive` catches
    // the same error and returns `false` (dead-pid carve-out). The
    // record's pid is arbitrary — no real process can be signaled
    // because `process.kill` itself is intercepted.
    const killCalls: Array<readonly [number, string | number]> = [];
    const killSpy = spyOn(process, "kill").mockImplementation(
      (pid: number, sig?: number | string) => {
        killCalls.push([pid, sig ?? 0] as const);
        const err = new Error("kill ESRCH: no such process") as Error & {
          code?: string;
        };
        err.code = "ESRCH";
        throw err;
      },
    );
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() =>
      makeSpawnResult(0, "Mon Jan  1 00:00:00 2024\n"),
    );

    const freshStamp = Date.now();
    await writeSession(dir, {
      workerId: workerId("w-resume"),
      status: "terminating",
      pid: 1, // Arbitrary — signaling is mocked, so no process is touched.
      signaledAt: freshStamp,
    });

    const writes: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    let code: ExitCode | undefined;
    try {
      code = await run(parseBgFlags(["kill", "w-resume", "--registry-dir", dir]));
    } finally {
      stdoutSpy.mockRestore();
      errSpy.mockRestore();
      killSpy.mockRestore();
      spawnSpy.mockRestore();
    }

    // Outcome assertions: kill returns OK, writes exited with the
    // preserved (fresh) `signaledAt`. If the claim had incorrectly
    // cleared the stamp, the post-run record would be missing it —
    // the test fails loud either way instead of passing on a
    // short-circuit path.
    expect(code).toBe(ExitCode.OK);
    // Prove the SIGTERM path was actually exercised — otherwise the
    // early dead-pid carve-out could short-circuit to the same
    // (exited + preserved signaledAt) outcome without testing the
    // claim→SIGTERM→finalize flow this regression is intended to
    // cover. If processBirthFingerprint ever returned undefined on
    // some host (ps unavailable), carve-out would run and this
    // assertion would loudly fail instead of silently passing.
    // We capture calls into a local array because `mockRestore()`
    // (ran in the finally block) clears `killSpy.mock.calls` in Bun.
    expect(killCalls).toContainEqual([1, "SIGTERM"]);
    const text = await Bun.file(join(dir, "w-resume.json")).text();
    const record = JSON.parse(text) as BackgroundSessionRecord;
    expect(record.status).toBe("exited");
    expect(record.signaledAt).toBe(freshStamp);
  }, 15_000);
});

describe("bg attach", () => {
  it("keeps subprocess attach as a log-follow fallback", async () => {
    const logPath = join(dir, "w-subprocess.log");
    await writeFile(logPath, "attached via logs\n", "utf8");
    await writeSession(dir, {
      workerId: workerId("w-subprocess"),
      backendKind: "subprocess",
      logPath,
      status: "exited",
      endedAt: Date.now(),
      exitCode: 0,
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      stdout.push(String(c));
      return true;
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });

    try {
      const code = await run(parseBgFlags(["attach", "w-subprocess", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.OK);
      expect(stderr.join("")).toContain(
        "Interactive attach is not supported on the subprocess backend",
      );
      expect(stdout.join("")).toContain("attached via logs");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("dispatches tmux attach when tmux metadata is present outside tmux", async () => {
    await writeSession(dir, {
      workerId: workerId("w-tmux-attach"),
      backendKind: "tmux",
      status: "detached",
      tmuxSessionName: "alpha-daemon-workers",
      tmuxWindowTarget: "alpha-daemon-workers:0",
      tmuxPaneId: "%7",
    });
    delete process.env.TMUX;

    const spawnCalls: string[][] = [];
    let resolveAttach: ((code: number) => void) | undefined;
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((argv: string[]) => {
      spawnCalls.push([...argv]);
      if (argv[0] === "tmux" && argv[1] === "attach-session") {
        const exited = new Promise<number>((resolve) => {
          resolveAttach = resolve;
        });
        return {
          exited,
          stdout: new Blob([]).stream(),
          stderr: new Blob([]).stream(),
        } as ReturnType<typeof Bun.spawn>;
      }
      return makeSpawnResult(0);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const runPromise = run(parseBgFlags(["attach", "w-tmux-attach", "--registry-dir", dir]));
      for (let attempt = 0; attempt < 50; attempt++) {
        if (spawnCalls.some((call) => call[0] === "tmux" && call[1] === "attach-session")) break;
        await Bun.sleep(1);
      }
      expect(spawnCalls).toContainEqual([
        "tmux",
        "set-option",
        "-p",
        "-t",
        "%7",
        "@koi_bg_attached_backend",
        "tmux",
      ]);
      expect(spawnCalls).toContainEqual([
        "tmux",
        "set-option",
        "-p",
        "-t",
        "%7",
        "@koi_bg_attached_worker_id",
        "w-tmux-attach",
      ]);
      expect(spawnCalls).toContainEqual([
        "tmux",
        "set-option",
        "-p",
        "-t",
        "%7",
        "@koi_bg_attached_session_name",
        "alpha-daemon-workers",
      ]);
      expect(spawnCalls).toContainEqual(["tmux", "select-window", "-t", "alpha-daemon-workers:0"]);
      expect(spawnCalls).toContainEqual(["tmux", "select-pane", "-t", "%7"]);
      expect(spawnCalls).toContainEqual(["tmux", "attach-session", "-t", "alpha-daemon-workers"]);

      const inFlightText = await Bun.file(join(dir, "w-tmux-attach.json")).text();
      const inFlightRecord = JSON.parse(inFlightText) as BackgroundSessionRecord;
      expect(inFlightRecord.status).toBe("running");

      resolveAttach?.(0);
      const code = await runPromise;
      expect(code).toBe(ExitCode.OK);
    } finally {
      stderrSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it("switches tmux clients in-place when already inside tmux", async () => {
    await writeSession(dir, {
      workerId: workerId("w-tmux-switch"),
      backendKind: "tmux",
      status: "detached",
      tmuxSessionName: "alpha-daemon-workers",
      tmuxWindowTarget: "alpha-daemon-workers:0",
      tmuxPaneId: "%11",
    });
    process.env.TMUX = "/tmp/tmux-1000/default,456,0";

    const spawnCalls: string[][] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((argv: string[]) => {
      spawnCalls.push([...argv]);
      return makeSpawnResult(0);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const code = await run(parseBgFlags(["attach", "w-tmux-switch", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.OK);
      expect(spawnCalls).toContainEqual([
        "tmux",
        "set-option",
        "-p",
        "-t",
        "%11",
        "@koi_bg_attached_worker_id",
        "w-tmux-switch",
      ]);
      expect(spawnCalls).toContainEqual(["tmux", "switch-client", "-t", "alpha-daemon-workers"]);
      expect(spawnCalls).toContainEqual(["tmux", "select-window", "-t", "alpha-daemon-workers:0"]);
      expect(spawnCalls).toContainEqual(["tmux", "select-pane", "-t", "%11"]);

      const text = await Bun.file(join(dir, "w-tmux-switch.json")).text();
      const record = JSON.parse(text) as BackgroundSessionRecord;
      expect(record.status).toBe("running");
    } finally {
      stderrSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it("rolls back the pre-handoff running state if outside-tmux attach-session fails immediately", async () => {
    await writeSession(dir, {
      workerId: workerId("w-tmux-attach-fail"),
      backendKind: "tmux",
      status: "detached",
      tmuxSessionName: "alpha-daemon-workers",
      tmuxWindowTarget: "alpha-daemon-workers:0",
      tmuxPaneId: "%13",
    });
    delete process.env.TMUX;

    const spawnCalls: string[][] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((argv: string[]) => {
      spawnCalls.push([...argv]);
      if (argv[0] === "tmux" && argv[1] === "attach-session") {
        return makeSpawnResult(1);
      }
      return makeSpawnResult(0);
    });
    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });

    try {
      const code = await run(parseBgFlags(["attach", "w-tmux-attach-fail", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.FAILURE);
      expect(spawnCalls).toContainEqual(["tmux", "attach-session", "-t", "alpha-daemon-workers"]);
      expect(stderr.join("")).toContain("tmux attach-session -t alpha-daemon-workers failed");

      const text = await Bun.file(join(dir, "w-tmux-attach-fail.json")).text();
      const record = JSON.parse(text) as BackgroundSessionRecord;
      expect(record.status).toBe("detached");
    } finally {
      stderrSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it("rolls back the pre-handoff running state if outside-tmux attach-session spawn throws synchronously", async () => {
    await writeSession(dir, {
      workerId: workerId("w-tmux-attach-throw"),
      backendKind: "tmux",
      status: "detached",
      tmuxSessionName: "alpha-daemon-workers",
      tmuxWindowTarget: "alpha-daemon-workers:0",
      tmuxPaneId: "%14",
    });
    delete process.env.TMUX;

    const spawnCalls: string[][] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((argv: string[]) => {
      spawnCalls.push([...argv]);
      if (argv[0] === "tmux" && argv[1] === "attach-session") {
        throw new Error("spawn failed");
      }
      return makeSpawnResult(0);
    });
    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });

    try {
      const code = await run(
        parseBgFlags(["attach", "w-tmux-attach-throw", "--registry-dir", dir]),
      );
      expect(code).toBe(ExitCode.FAILURE);
      expect(spawnCalls).toContainEqual(["tmux", "attach-session", "-t", "alpha-daemon-workers"]);

      const text = await Bun.file(join(dir, "w-tmux-attach-throw.json")).text();
      const record = JSON.parse(text) as BackgroundSessionRecord;
      expect(record.status).toBe("detached");
      expect(stderr.join("")).toContain("spawn failed");
    } finally {
      stderrSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it("fails clearly when tmux attach metadata is missing", async () => {
    await writeSession(dir, {
      workerId: workerId("w-tmux-missing"),
      backendKind: "tmux",
    });

    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });

    try {
      const code = await run(parseBgFlags(["attach", "w-tmux-missing", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.FAILURE);
      expect(stderr.join("")).toContain("missing persisted tmux metadata");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("bg detach", () => {
  it("stays informational for non-tmux backends", async () => {
    delete process.env.KOI_BG_ATTACHED_BACKEND;
    delete process.env.KOI_BG_ATTACHED_WORKER_ID;
    delete process.env.KOI_BG_ATTACHED_SESSION_NAME;

    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });

    try {
      const code = await run(parseBgFlags(["detach", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.OK);
      expect(stderr.join("")).toContain("subprocess backend has no detachable session");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("detaches tmux-backed sessions through the pane-scoped attach-path contract", async () => {
    await writeSession(dir, {
      workerId: workerId("w-tmux-detach"),
      backendKind: "tmux",
      status: "running",
      tmuxSessionName: "alpha-daemon-workers",
      tmuxWindowTarget: "alpha-daemon-workers:0",
      tmuxPaneId: "%9",
    });
    process.env.TMUX = "/tmp/tmux-1000/default,123,0";
    delete process.env.KOI_BG_ATTACHED_BACKEND;
    delete process.env.KOI_BG_ATTACHED_WORKER_ID;
    delete process.env.KOI_BG_ATTACHED_SESSION_NAME;

    const spawnCalls: string[][] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((argv: string[]) => {
      spawnCalls.push([...argv]);
      if (
        argv[0] === "tmux" &&
        argv[1] === "display-message" &&
        argv[2] === "-p" &&
        argv[3] === "#{pane_id}"
      ) {
        return makeSpawnResult(0, "%9\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%9" &&
        argv[5] === "-v" &&
        argv[6] === "@koi_bg_attached_backend"
      ) {
        return makeSpawnResult(0, "tmux\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%9" &&
        argv[5] === "-v" &&
        argv[6] === "@koi_bg_attached_worker_id"
      ) {
        return makeSpawnResult(0, "w-tmux-detach\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%9" &&
        argv[5] === "-v" &&
        argv[6] === "@koi_bg_attached_session_name"
      ) {
        return makeSpawnResult(0, "alpha-daemon-workers\n");
      }
      return makeSpawnResult(0);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const code = await run(parseBgFlags(["detach", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.OK);
      expect(spawnCalls).toContainEqual(["tmux", "display-message", "-p", "#{pane_id}"]);
      expect(spawnCalls).toContainEqual(["tmux", "detach-client"]);

      const text = await Bun.file(join(dir, "w-tmux-detach.json")).text();
      const record = JSON.parse(text) as BackgroundSessionRecord;
      expect(record.status).toBe("detached");
    } finally {
      stderrSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it("falls back to pane-scoped tmux options when process env is absent", async () => {
    await writeSession(dir, {
      workerId: workerId("w-tmux-fallback"),
      backendKind: "tmux",
      status: "running",
      tmuxSessionName: "alpha-daemon-workers",
      tmuxWindowTarget: "alpha-daemon-workers:0",
      tmuxPaneId: "%21",
    });
    process.env.TMUX = "/tmp/tmux-1000/default,789,0";
    delete process.env.KOI_BG_ATTACHED_BACKEND;
    delete process.env.KOI_BG_ATTACHED_WORKER_ID;
    delete process.env.KOI_BG_ATTACHED_SESSION_NAME;

    const spawnCalls: string[][] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((argv: string[]) => {
      spawnCalls.push([...argv]);
      if (
        argv[0] === "tmux" &&
        argv[1] === "display-message" &&
        argv[2] === "-p" &&
        argv[3] === "#{pane_id}"
      ) {
        return makeSpawnResult(0, "%21\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%21" &&
        argv[5] === "-v" &&
        argv[6] === "@koi_bg_attached_backend"
      ) {
        return makeSpawnResult(0, "tmux\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%21" &&
        argv[5] === "-v" &&
        argv[6] === "@koi_bg_attached_worker_id"
      ) {
        return makeSpawnResult(0, "w-tmux-fallback\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%21" &&
        argv[5] === "-v" &&
        argv[6] === "@koi_bg_attached_session_name"
      ) {
        return makeSpawnResult(0, "alpha-daemon-workers\n");
      }
      return makeSpawnResult(0);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const code = await run(parseBgFlags(["detach", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.OK);
      expect(spawnCalls).toContainEqual(["tmux", "display-message", "-p", "#{pane_id}"]);
      expect(spawnCalls).toContainEqual([
        "tmux",
        "show-options",
        "-p",
        "-t",
        "%21",
        "-v",
        "@koi_bg_attached_worker_id",
      ]);
      expect(spawnCalls).toContainEqual(["tmux", "detach-client"]);

      const text = await Bun.file(join(dir, "w-tmux-fallback.json")).text();
      const record = JSON.parse(text) as BackgroundSessionRecord;
      expect(record.status).toBe("detached");
    } finally {
      stderrSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it("resolves the current pane so same-session workers do not collide on detach fallback", async () => {
    await writeSession(dir, {
      workerId: workerId("w-pane-a"),
      backendKind: "tmux",
      status: "running",
      tmuxSessionName: "alpha-daemon-workers",
      tmuxWindowTarget: "alpha-daemon-workers:0",
      tmuxPaneId: "%31",
    });
    await writeSession(dir, {
      workerId: workerId("w-pane-b"),
      backendKind: "tmux",
      status: "running",
      tmuxSessionName: "alpha-daemon-workers",
      tmuxWindowTarget: "alpha-daemon-workers:0",
      tmuxPaneId: "%32",
    });
    process.env.TMUX = "/tmp/tmux-1000/default,999,0";
    delete process.env.KOI_BG_ATTACHED_BACKEND;
    delete process.env.KOI_BG_ATTACHED_WORKER_ID;
    delete process.env.KOI_BG_ATTACHED_SESSION_NAME;

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((argv: string[]) => {
      if (
        argv[0] === "tmux" &&
        argv[1] === "display-message" &&
        argv[2] === "-p" &&
        argv[3] === "#{pane_id}"
      ) {
        return makeSpawnResult(0, "%32\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%32" &&
        argv[5] === "-v" &&
        argv[6] === "@koi_bg_attached_backend"
      ) {
        return makeSpawnResult(0, "tmux\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%32" &&
        argv[5] === "-v" &&
        argv[6] === "@koi_bg_attached_worker_id"
      ) {
        return makeSpawnResult(0, "w-pane-b\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%32" &&
        argv[5] === "-v" &&
        argv[6] === "@koi_bg_attached_session_name"
      ) {
        return makeSpawnResult(0, "alpha-daemon-workers\n");
      }
      return makeSpawnResult(0);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const code = await run(parseBgFlags(["detach", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.OK);

      const paneA = JSON.parse(
        await Bun.file(join(dir, "w-pane-a.json")).text(),
      ) as BackgroundSessionRecord;
      const paneB = JSON.parse(
        await Bun.file(join(dir, "w-pane-b.json")).text(),
      ) as BackgroundSessionRecord;
      expect(paneA.status).toBe("running");
      expect(paneB.status).toBe("detached");
    } finally {
      stderrSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it("prefers current pane metadata over stale process env when already inside tmux", async () => {
    await writeSession(dir, {
      workerId: workerId("w-stale-env"),
      backendKind: "tmux",
      status: "running",
      tmuxSessionName: "alpha-daemon-workers",
      tmuxWindowTarget: "alpha-daemon-workers:0",
      tmuxPaneId: "%41",
    });
    await writeSession(dir, {
      workerId: workerId("w-live-pane"),
      backendKind: "tmux",
      status: "running",
      tmuxSessionName: "alpha-daemon-workers",
      tmuxWindowTarget: "alpha-daemon-workers:0",
      tmuxPaneId: "%42",
    });
    process.env.TMUX = "/tmp/tmux-1000/default,111,0";
    process.env.KOI_BG_ATTACHED_BACKEND = "tmux";
    process.env.KOI_BG_ATTACHED_WORKER_ID = "w-stale-env";
    process.env.KOI_BG_ATTACHED_SESSION_NAME = "alpha-daemon-workers";

    const spawnCalls: string[][] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((argv: string[]) => {
      spawnCalls.push([...argv]);
      if (
        argv[0] === "tmux" &&
        argv[1] === "display-message" &&
        argv[2] === "-p" &&
        argv[3] === "#{pane_id}"
      ) {
        return makeSpawnResult(0, "%42\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%42" &&
        argv[5] === "-v" &&
        argv[6] === "@koi_bg_attached_backend"
      ) {
        return makeSpawnResult(0, "tmux\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%42" &&
        argv[5] === "-v" &&
        argv[6] === "@koi_bg_attached_worker_id"
      ) {
        return makeSpawnResult(0, "w-live-pane\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%42" &&
        argv[5] === "-v" &&
        argv[6] === "@koi_bg_attached_session_name"
      ) {
        return makeSpawnResult(0, "alpha-daemon-workers\n");
      }
      return makeSpawnResult(0);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const code = await run(parseBgFlags(["detach", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.OK);
      expect(spawnCalls).toContainEqual(["tmux", "display-message", "-p", "#{pane_id}"]);
      expect(spawnCalls).toContainEqual([
        "tmux",
        "show-options",
        "-p",
        "-t",
        "%42",
        "-v",
        "@koi_bg_attached_worker_id",
      ]);

      const staleEnv = JSON.parse(
        await Bun.file(join(dir, "w-stale-env.json")).text(),
      ) as BackgroundSessionRecord;
      const livePane = JSON.parse(
        await Bun.file(join(dir, "w-live-pane.json")).text(),
      ) as BackgroundSessionRecord;
      expect(staleEnv.status).toBe("running");
      expect(livePane.status).toBe("detached");
    } finally {
      stderrSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it("fails closed inside tmux when pane metadata is missing even if stale env is present", async () => {
    await writeSession(dir, {
      workerId: workerId("w-stale-only"),
      backendKind: "tmux",
      status: "running",
      tmuxSessionName: "alpha-daemon-workers",
      tmuxWindowTarget: "alpha-daemon-workers:0",
      tmuxPaneId: "%51",
    });
    process.env.TMUX = "/tmp/tmux-1000/default,222,0";
    process.env.KOI_BG_ATTACHED_BACKEND = "tmux";
    process.env.KOI_BG_ATTACHED_WORKER_ID = "w-stale-only";
    process.env.KOI_BG_ATTACHED_SESSION_NAME = "alpha-daemon-workers";

    const spawnCalls: string[][] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((argv: string[]) => {
      spawnCalls.push([...argv]);
      if (
        argv[0] === "tmux" &&
        argv[1] === "display-message" &&
        argv[2] === "-p" &&
        argv[3] === "#{pane_id}"
      ) {
        return makeSpawnResult(0, "%52\n");
      }
      if (
        argv[0] === "tmux" &&
        argv[1] === "show-options" &&
        argv[2] === "-p" &&
        argv[3] === "-t" &&
        argv[4] === "%52" &&
        argv[5] === "-v"
      ) {
        return makeSpawnResult(1, "", "unknown option\n");
      }
      return makeSpawnResult(0);
    });
    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });

    try {
      const code = await run(parseBgFlags(["detach", "--registry-dir", dir]));
      expect(code).toBe(ExitCode.FAILURE);
      expect(spawnCalls).toContainEqual(["tmux", "display-message", "-p", "#{pane_id}"]);
      expect(spawnCalls).toContainEqual([
        "tmux",
        "show-options",
        "-p",
        "-t",
        "%52",
        "-v",
        "@koi_bg_attached_worker_id",
      ]);
      expect(stderr.join("")).toContain(
        "could not resolve the attached worker from the current tmux pane",
      );

      const staleOnly = JSON.parse(
        await Bun.file(join(dir, "w-stale-only.json")).text(),
      ) as BackgroundSessionRecord;
      expect(staleOnly.status).toBe("running");
    } finally {
      stderrSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });
});
