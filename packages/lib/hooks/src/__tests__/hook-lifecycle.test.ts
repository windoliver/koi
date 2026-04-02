/**
 * Integration tests for hook lifecycle — real process spawns and HTTP requests.
 *
 * These tests verify that:
 * - Command hooks spawn real processes and exit cleanly
 * - Command hooks are killed when the session signal aborts
 * - HTTP hooks make real requests to a local server
 * - HTTP hooks are aborted when the session signal aborts
 * - Timed-out hooks are cleaned up
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { HookConfig, HookEvent } from "@koi/core";
import { executeHooks } from "../executor.js";

const baseEvent: HookEvent = {
  event: "session.started",
  agentId: "agent-1",
  sessionId: "session-1",
};

// ---------------------------------------------------------------------------
// Local HTTP test server
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let serverUrl: string;
let lastRequestBody: unknown = null;
let lastRequestHeaders: Record<string, string> = {};
let requestCount = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0, // random available port
    fetch(req) {
      requestCount++;
      const url = new URL(req.url);

      if (url.pathname === "/slow") {
        // Simulate a slow endpoint — wait 5 seconds
        return new Promise((resolve) => {
          setTimeout(() => resolve(new Response("ok")), 5000);
        });
      }

      if (url.pathname === "/error") {
        return new Response("Internal Server Error", { status: 500 });
      }

      // Normal endpoint — record body and headers
      return req.json().then((body) => {
        lastRequestBody = body;
        lastRequestHeaders = Object.fromEntries(req.headers.entries());
        return new Response("ok", { status: 200 });
      });
    },
  });
  serverUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

// ---------------------------------------------------------------------------
// Command hook tests
// ---------------------------------------------------------------------------

describe("command hook execution (integration)", () => {
  it("spawns a process and returns success on exit 0", async () => {
    const hook: HookConfig = {
      kind: "command",
      name: "echo-test",
      cmd: ["echo", "hello"],
      timeoutMs: 5000,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.hookName).toBe("echo-test");
    expect(results[0]?.durationMs).toBeGreaterThan(0);
  });

  it("returns failure for non-zero exit code", async () => {
    const hook: HookConfig = {
      kind: "command",
      name: "fail-test",
      cmd: ["sh", "-c", "exit 1"],
      timeoutMs: 5000,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    if (!results[0]?.ok) {
      expect(results[0]?.error).toContain("exit code 1");
    }
  });

  it("kills process when session signal aborts", async () => {
    const hook: HookConfig = {
      kind: "command",
      name: "sleep-test",
      cmd: ["sleep", "30"],
      timeoutMs: 60000,
    };

    const controller = new AbortController();

    // Abort after 100ms
    setTimeout(() => controller.abort(), 100);

    const results = await executeHooks([hook], baseEvent, controller.signal);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    if (!results[0]?.ok) {
      expect(results[0]?.error).toMatch(/abort/i);
    }
  });

  it("times out a long-running process", async () => {
    const hook: HookConfig = {
      kind: "command",
      name: "timeout-test",
      cmd: ["sleep", "30"],
      timeoutMs: 200, // Very short timeout
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    // Should complete in ~200ms, not 30s
    expect(results[0]?.durationMs).toBeLessThan(5000);
  });

  it("returns error when command does not exist", async () => {
    const hook: HookConfig = {
      kind: "command",
      name: "nonexistent-cmd",
      cmd: ["/usr/bin/this-command-does-not-exist-98765"],
      timeoutMs: 5000,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
  });

  it("passes environment variables to child process", async () => {
    const hook: HookConfig = {
      kind: "command",
      name: "env-test",
      cmd: ["sh", "-c", 'test "$TEST_VAR" = "hello"'],
      env: { TEST_VAR: "hello" },
      timeoutMs: 5000,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP hook tests
// ---------------------------------------------------------------------------

describe("http hook execution (integration)", () => {
  it("sends POST request with event data", async () => {
    requestCount = 0;
    lastRequestBody = null;

    const hook: HookConfig = {
      kind: "http",
      name: "http-test",
      url: `${serverUrl}/hook`,
      timeoutMs: 5000,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(requestCount).toBe(1);
    expect(lastRequestBody).toEqual(baseEvent);
  });

  it("sends custom headers", async () => {
    lastRequestHeaders = {};

    const hook: HookConfig = {
      kind: "http",
      name: "headers-test",
      url: `${serverUrl}/hook`,
      headers: { "X-Custom": "value" },
      timeoutMs: 5000,
    };

    await executeHooks([hook], baseEvent);
    expect(lastRequestHeaders["x-custom"]).toBe("value");
    expect(lastRequestHeaders["content-type"]).toBe("application/json");
  });

  it("returns failure for HTTP error response", async () => {
    const hook: HookConfig = {
      kind: "http",
      name: "error-test",
      url: `${serverUrl}/error`,
      timeoutMs: 5000,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    if (!results[0]?.ok) {
      expect(results[0]?.error).toContain("500");
    }
  });

  it("adds HMAC signature header when secret is provided", async () => {
    lastRequestHeaders = {};

    const hook: HookConfig = {
      kind: "http",
      name: "hmac-test",
      url: `${serverUrl}/hook`,
      secret: "test-secret",
      timeoutMs: 5000,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(lastRequestHeaders["x-hook-signature"]).toMatch(/^sha256=[0-9a-f]+$/);
  });

  it("expands env vars in headers", async () => {
    const originalEnv = process.env.HOOK_TEST_TOKEN;
    process.env.HOOK_TEST_TOKEN = "resolved-token";
    lastRequestHeaders = {};

    const hook: HookConfig = {
      kind: "http",
      name: "env-header-test",
      url: `${serverUrl}/hook`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
      headers: { Authorization: "Bearer ${HOOK_TEST_TOKEN}" },
      timeoutMs: 5000,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(lastRequestHeaders.authorization).toBe("Bearer resolved-token");

    // Restore
    if (originalEnv === undefined) {
      delete process.env.HOOK_TEST_TOKEN;
    } else {
      process.env.HOOK_TEST_TOKEN = originalEnv;
    }
  });

  it("fails when headers reference unresolved env vars", async () => {
    // Ensure the var does NOT exist
    delete process.env.MISSING_HOOK_VAR_99999;

    const hook: HookConfig = {
      kind: "http",
      name: "missing-env-test",
      url: `${serverUrl}/hook`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
      headers: { Authorization: "Bearer ${MISSING_HOOK_VAR_99999}" },
      timeoutMs: 5000,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    if (results[0] && !results[0].ok) {
      expect(results[0].error).toContain("env var errors in headers");
      expect(results[0].error).toContain("MISSING_HOOK_VAR_99999");
    }
  });

  it("fails when secret references unresolved env vars", async () => {
    delete process.env.MISSING_SECRET_VAR_99999;

    const hook: HookConfig = {
      kind: "http",
      name: "missing-secret-test",
      url: `${serverUrl}/hook`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
      secret: "${MISSING_SECRET_VAR_99999}",
      timeoutMs: 5000,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    if (results[0] && !results[0].ok) {
      expect(results[0].error).toContain("env var errors in secret");
    }
  });

  it("aborts request when session signal fires", async () => {
    const hook: HookConfig = {
      kind: "http",
      name: "abort-http-test",
      url: `${serverUrl}/slow`,
      timeoutMs: 60000,
    };

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const results = await executeHooks([hook], baseEvent, controller.signal);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.durationMs).toBeLessThan(5000);
  });

  it("times out a slow HTTP endpoint", async () => {
    const hook: HookConfig = {
      kind: "http",
      name: "timeout-http-test",
      url: `${serverUrl}/slow`,
      timeoutMs: 200,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.durationMs).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Mixed execution model tests
// ---------------------------------------------------------------------------

describe("parallel and serial execution (integration)", () => {
  it("runs parallel hooks concurrently", async () => {
    const hooks: readonly HookConfig[] = [
      { kind: "command", name: "p1", cmd: ["sleep", "0.1"], timeoutMs: 5000 },
      { kind: "command", name: "p2", cmd: ["sleep", "0.1"], timeoutMs: 5000 },
      { kind: "command", name: "p3", cmd: ["sleep", "0.1"], timeoutMs: 5000 },
    ];

    const start = performance.now();
    const results = await executeHooks(hooks, baseEvent);
    const elapsed = performance.now() - start;

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    // All three should complete in roughly 100ms (parallel), not 300ms (serial)
    expect(elapsed).toBeLessThan(2000);
  });

  it("runs serial hooks sequentially", async () => {
    const hooks: readonly HookConfig[] = [
      { kind: "command", name: "s1", cmd: ["sleep", "0.1"], serial: true, timeoutMs: 5000 },
      { kind: "command", name: "s2", cmd: ["sleep", "0.1"], serial: true, timeoutMs: 5000 },
    ];

    const start = performance.now();
    const results = await executeHooks(hooks, baseEvent);
    const elapsed = performance.now() - start;

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    // Serial should take at least 200ms
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  it("preserves declaration order for mixed serial/parallel hooks", async () => {
    const hooks: readonly HookConfig[] = [
      { kind: "command", name: "serial-first", cmd: ["echo", "1"], serial: true, timeoutMs: 5000 },
      { kind: "command", name: "parallel-second", cmd: ["echo", "2"], timeoutMs: 5000 },
      { kind: "command", name: "parallel-third", cmd: ["echo", "3"], timeoutMs: 5000 },
      { kind: "command", name: "serial-fourth", cmd: ["echo", "4"], serial: true, timeoutMs: 5000 },
    ];

    const results = await executeHooks(hooks, baseEvent);
    expect(results).toHaveLength(4);
    expect(results[0]?.hookName).toBe("serial-first");
    expect(results[1]?.hookName).toBe("parallel-second");
    expect(results[2]?.hookName).toBe("parallel-third");
    expect(results[3]?.hookName).toBe("serial-fourth");
  });
});

// ---------------------------------------------------------------------------
// Runtime URL policy enforcement
// ---------------------------------------------------------------------------

describe("runtime URL policy (integration)", () => {
  it("rejects HTTP URL at execution time even when bypassing loadHooks", async () => {
    // Construct HookConfig directly — skipping schema validation
    const hook: HookConfig = {
      kind: "http",
      name: "bypass-test",
      url: "http://evil.example.com/exfiltrate",
      timeoutMs: 5000,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    if (results[0] && !results[0].ok) {
      expect(results[0].error).toContain("URL rejected");
    }
  });

  it("allows HTTPS URL at execution time", async () => {
    // This will fail with a network error (no server), but should NOT be
    // rejected by URL validation — proving the policy lets HTTPS through
    const hook: HookConfig = {
      kind: "http",
      name: "https-test",
      url: "https://unreachable.example.invalid/hook",
      timeoutMs: 1000,
    };

    const results = await executeHooks([hook], baseEvent);
    expect(results).toHaveLength(1);
    // Should fail with a network error, NOT a URL policy error
    if (results[0] && !results[0].ok) {
      expect(results[0].error).not.toContain("URL rejected");
    }
  });
});
