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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "koi-bg-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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
    const killSpy = spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill ESRCH: no such process") as Error & {
        code?: string;
      };
      err.code = "ESRCH";
      throw err;
    });

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
    }

    // Outcome assertions: kill returns OK, writes exited with the
    // preserved (fresh) `signaledAt`. If the claim had incorrectly
    // cleared the stamp, the post-run record would be missing it —
    // the test fails loud either way instead of passing on a
    // short-circuit path.
    expect(code).toBe(ExitCode.OK);
    const text = await Bun.file(join(dir, "w-resume.json")).text();
    const record = JSON.parse(text) as BackgroundSessionRecord;
    expect(record.status).toBe("exited");
    expect(record.signaledAt).toBe(freshStamp);
  }, 15_000);
});
