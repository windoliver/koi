import { describe, expect, mock, test } from "bun:test";
import type {
  KoiError,
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
  Result,
} from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createNexusPermissionBackend } from "./nexus-permission-backend.js";

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

type CallArgs = Record<string, unknown>;

const ALLOW: PermissionDecision = { effect: "allow" };
const DENY: PermissionDecision = { effect: "deny", reason: "denied" };

const SAMPLE_QUERY: PermissionQuery = {
  principal: "agent:test",
  action: "read_file",
  resource: "/workspace/src/foo.ts",
};

const VERSION_JSON = JSON.stringify({ version: 1, updatedAt: Date.now() });
const POLICY_JSON = JSON.stringify({ rules: [] });

function makeTransport(
  handler: (method: string, params: CallArgs) => Promise<Result<string, KoiError>>,
): NexusTransport {
  return {
    call: handler as NexusTransport["call"],
    close: () => {},
  };
}

function notFoundResult(): Result<string, KoiError> {
  return {
    ok: false,
    error: { code: "NOT_FOUND", message: "not found", retryable: false },
  };
}

function timeoutResult(): Result<string, KoiError> {
  return {
    ok: false,
    error: { code: "TIMEOUT", message: "timeout", retryable: true },
  };
}

function okResult(value: string): Result<string, KoiError> {
  return { ok: true, value };
}

function makeLocalBackend(decision: PermissionDecision = ALLOW): PermissionBackend {
  return {
    check: () => decision,
  };
}

describe("createNexusPermissionBackend", () => {
  test("check() delegates to local backend — transport is not called for check itself", async () => {
    const transportCalls: string[] = [];
    const backend = createNexusPermissionBackend({
      transport: makeTransport(async (method) => {
        transportCalls.push(method);
        return notFoundResult();
      }),
      localBackend: makeLocalBackend(ALLOW),
      getCurrentPolicy: () => ({}),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: 0,
    });

    // Flush init (which may call transport)
    await flushMicrotasks();
    const callCountAfterInit = transportCalls.length;

    // check() itself must NOT call transport
    const decision = await Promise.resolve(backend.check(SAMPLE_QUERY));
    expect(decision).toEqual(ALLOW);
    expect(transportCalls.length).toBe(callCountAfterInit); // no extra calls
    backend.dispose();
  });

  test("check() returns deny decision from local backend", async () => {
    const backend = createNexusPermissionBackend({
      transport: makeTransport(async () => notFoundResult()),
      localBackend: makeLocalBackend(DENY),
      getCurrentPolicy: () => ({}),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    const decision = await Promise.resolve(backend.check(SAMPLE_QUERY));
    expect(decision.effect).toBe("deny");
    backend.dispose();
  });

  test("checkBatch() delegates to local backend", async () => {
    const checkMock = mock(() => ALLOW);
    const localBackend: PermissionBackend = { check: checkMock };

    const backend = createNexusPermissionBackend({
      transport: makeTransport(async () => notFoundResult()),
      localBackend,
      getCurrentPolicy: () => ({}),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: 0,
    });

    await flushMicrotasks();

    const queries = [SAMPLE_QUERY, SAMPLE_QUERY];
    const results = await backend.checkBatch(queries);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(ALLOW);
    expect(results[1]).toEqual(ALLOW);
    expect(checkMock).toHaveBeenCalledTimes(2);
    backend.dispose();
  });

  test("checkBatch() uses localBackend.checkBatch when available", async () => {
    const checkBatchMock = mock((_queries: readonly PermissionQuery[]) => [ALLOW, DENY]);
    const localBackend: PermissionBackend = {
      check: () => ALLOW,
      checkBatch: checkBatchMock,
    };

    const backend = createNexusPermissionBackend({
      transport: makeTransport(async () => notFoundResult()),
      localBackend,
      getCurrentPolicy: () => ({}),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: 0,
    });

    await flushMicrotasks();

    const results = await backend.checkBatch([SAMPLE_QUERY, SAMPLE_QUERY]);
    expect(results[0]).toEqual(ALLOW);
    expect(results[1]).toEqual(DENY);
    expect(checkBatchMock).toHaveBeenCalledTimes(1);
    backend.dispose();
  });

  test("does NOT write to Nexus on construction when version.json returns NOT_FOUND (run local-only)", async () => {
    const calls: Array<{ method: string; params: CallArgs }> = [];
    const backend = createNexusPermissionBackend({
      transport: makeTransport(async (method, params) => {
        calls.push({ method, params });
        // version.json NOT_FOUND — must NOT trigger any write (concurrent nodes could race)
        return notFoundResult();
      }),
      localBackend: makeLocalBackend(),
      getCurrentPolicy: () => ({ rules: ["default-deny"] }),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));

    const writeCalls = calls.filter((c) => c.method === "write");
    expect(writeCalls).toHaveLength(0); // no write — avoids concurrent-node race
    backend.dispose();
  });

  test("loads policy from Nexus on construction when version.json exists", async () => {
    const rebuildMock = mock((_policy: unknown): PermissionBackend => makeLocalBackend(DENY));

    const backend = createNexusPermissionBackend({
      transport: makeTransport(async (_method, params) => {
        const path = params.path as string;
        if (path.endsWith("version.json")) return okResult(VERSION_JSON);
        if (path.endsWith("policy.json")) return okResult(POLICY_JSON);
        return notFoundResult();
      }),
      localBackend: makeLocalBackend(ALLOW),
      getCurrentPolicy: () => ({}),
      rebuildBackend: rebuildMock,
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));

    expect(rebuildMock).toHaveBeenCalledTimes(1);
    expect(rebuildMock).toHaveBeenCalledWith({ rules: [] });

    // After rebuild, check() should use the rebuilt backend (returns DENY)
    const decision = await Promise.resolve(backend.check(SAMPLE_QUERY));
    expect(decision.effect).toBe("deny");
    backend.dispose();
  });

  test("runs on local rules when Nexus unreachable at startup", async () => {
    const rebuildMock = mock((_policy: unknown): PermissionBackend => makeLocalBackend(DENY));

    const backend = createNexusPermissionBackend({
      transport: makeTransport(async () => timeoutResult()),
      localBackend: makeLocalBackend(ALLOW),
      getCurrentPolicy: () => ({}),
      rebuildBackend: rebuildMock,
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));

    expect(rebuildMock).not.toHaveBeenCalled();

    // Should still use local backend (ALLOW)
    const decision = await Promise.resolve(backend.check(SAMPLE_QUERY));
    expect(decision.effect).toBe("allow");
    backend.dispose();
  });

  test("poll skips rebuild when version unchanged", async () => {
    const rebuildMock = mock((_policy: unknown): PermissionBackend => makeLocalBackend());
    let _callCount = 0;

    const backend = createNexusPermissionBackend({
      transport: makeTransport(async (_method, params) => {
        _callCount++;
        const path = params.path as string;
        if (path.endsWith("version.json")) return okResult(VERSION_JSON);
        if (path.endsWith("policy.json")) return okResult(POLICY_JSON);
        return notFoundResult();
      }),
      localBackend: makeLocalBackend(),
      getCurrentPolicy: () => ({}),
      rebuildBackend: rebuildMock,
      syncIntervalMs: 0,
    });

    // Wait for init to complete (which calls rebuild once)
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));

    const rebuildCountAfterInit = rebuildMock.mock.calls.length;

    // Poll again — version is still 1, same as lastSeenVersion
    await backend._poll();

    // Rebuild should NOT have been called again
    expect(rebuildMock.mock.calls.length).toBe(rebuildCountAfterInit);
    backend.dispose();
  });

  test("poll triggers rebuild when version changes", async () => {
    const rebuildMock = mock((_policy: unknown): PermissionBackend => makeLocalBackend(DENY));
    // let justified: mutable state to simulate version bump
    let currentVersion = 1;

    const backend = createNexusPermissionBackend({
      transport: makeTransport(async (_method, params) => {
        const path = params.path as string;
        if (path.endsWith("version.json")) {
          return okResult(JSON.stringify({ version: currentVersion, updatedAt: Date.now() }));
        }
        if (path.endsWith("policy.json")) return okResult(POLICY_JSON);
        return notFoundResult();
      }),
      localBackend: makeLocalBackend(ALLOW),
      getCurrentPolicy: () => ({}),
      rebuildBackend: rebuildMock,
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));

    const rebuildCountAfterInit = rebuildMock.mock.calls.length;

    // Bump version to simulate remote change
    currentVersion = 2;
    await backend._poll();

    expect(rebuildMock.mock.calls.length).toBeGreaterThan(rebuildCountAfterInit);

    // Now check() should use rebuilt backend (DENY)
    const decision = await Promise.resolve(backend.check(SAMPLE_QUERY));
    expect(decision.effect).toBe("deny");
    backend.dispose();
  });

  test("dispose() clears interval without throwing", async () => {
    const backend = createNexusPermissionBackend({
      transport: makeTransport(async () => notFoundResult()),
      localBackend: makeLocalBackend(),
      getCurrentPolicy: () => ({}),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: 5000,
    });

    await flushMicrotasks();
    expect(() => backend.dispose()).not.toThrow();
  });

  test("dispose() is idempotent", async () => {
    const backend = createNexusPermissionBackend({
      transport: makeTransport(async () => notFoundResult()),
      localBackend: makeLocalBackend(),
      getCurrentPolicy: () => ({}),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    backend.dispose();
    expect(() => backend.dispose()).not.toThrow();
  });

  test("init: skips rebuild on malformed JSON in policy.json", async () => {
    const rebuildMock = mock((_policy: unknown): PermissionBackend => makeLocalBackend(DENY));

    const backend = createNexusPermissionBackend({
      transport: makeTransport(async (_method, params) => {
        const path = params.path as string;
        if (path.endsWith("version.json")) return okResult(VERSION_JSON);
        if (path.endsWith("policy.json")) return okResult("{{not-valid-json");
        return notFoundResult();
      }),
      localBackend: makeLocalBackend(ALLOW),
      getCurrentPolicy: () => ({}),
      rebuildBackend: rebuildMock,
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));

    // Rebuild must NOT have been called (malformed JSON → catch branch → warn + skip)
    expect(rebuildMock).not.toHaveBeenCalled();

    // Local backend (ALLOW) is still active
    const decision = await Promise.resolve(backend.check(SAMPLE_QUERY));
    expect(decision.effect).toBe("allow");
    backend.dispose();
  });

  test("poll: skips rebuild on malformed version.json JSON", async () => {
    const rebuildMock = mock((_policy: unknown): PermissionBackend => makeLocalBackend(DENY));

    const backend = createNexusPermissionBackend({
      transport: makeTransport(async (_method, params) => {
        const path = params.path as string;
        // Init: version.json returns NOT_FOUND so we skip rebuild on init
        if (path.endsWith("version.json")) return notFoundResult();
        return notFoundResult();
      }),
      localBackend: makeLocalBackend(ALLOW),
      getCurrentPolicy: () => ({}),
      rebuildBackend: rebuildMock,
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));

    // Now poll with malformed version.json
    const pollTransport = makeTransport(async (_method, params) => {
      const path = params.path as string;
      if (path.endsWith("version.json")) return okResult("{{malformed");
      return notFoundResult();
    });

    // Override transport via _poll using a separate backend
    const backend2 = createNexusPermissionBackend({
      transport: pollTransport,
      localBackend: makeLocalBackend(ALLOW),
      getCurrentPolicy: () => ({}),
      rebuildBackend: rebuildMock,
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));
    const callsBefore = rebuildMock.mock.calls.length;

    await backend2._poll();
    // Malformed version.json → catch → return early, no rebuild
    expect(rebuildMock.mock.calls.length).toBe(callsBefore);

    backend.dispose();
    backend2.dispose();
  });

  test("poll: skips rebuild on malformed policy.json during sync", async () => {
    const rebuildMock = mock((_policy: unknown): PermissionBackend => makeLocalBackend(DENY));
    // let justified: mutable state to simulate version bump
    let _callCount = 0;

    const backend = createNexusPermissionBackend({
      transport: makeTransport(async (_method, params) => {
        _callCount++;
        const path = params.path as string;
        if (path.endsWith("version.json")) return okResult(VERSION_JSON);
        if (path.endsWith("policy.json")) return okResult(POLICY_JSON);
        return notFoundResult();
      }),
      localBackend: makeLocalBackend(ALLOW),
      getCurrentPolicy: () => ({}),
      rebuildBackend: rebuildMock,
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));

    const rebuildCountAfterInit = rebuildMock.mock.calls.length;

    // Now poll: version changes but policy.json returns malformed JSON
    const backend2 = createNexusPermissionBackend({
      transport: makeTransport(async (_method, params) => {
        const path = params.path as string;
        // Return a different version to trigger rebuild attempt
        if (path.endsWith("version.json"))
          return okResult(JSON.stringify({ version: 99, updatedAt: Date.now() }));
        if (path.endsWith("policy.json")) return okResult("{{malformed-json");
        return notFoundResult();
      }),
      localBackend: makeLocalBackend(ALLOW),
      getCurrentPolicy: () => ({}),
      rebuildBackend: rebuildMock,
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));

    const rebuildCountAfterInit2 = rebuildMock.mock.calls.length;
    await backend2._poll();
    // policy.json malformed → catch → warn + skip, no extra rebuild
    expect(rebuildMock.mock.calls.length).toBe(rebuildCountAfterInit2);

    backend.dispose();
    backend2.dispose();
    void rebuildCountAfterInit; // suppress unused warning
  });

  test("startPolling activates when syncIntervalMs > 0", async () => {
    const backend = createNexusPermissionBackend({
      transport: makeTransport(async () => notFoundResult()),
      localBackend: makeLocalBackend(),
      getCurrentPolicy: () => ({}),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: 60_000, // non-zero — polling should be active
    });

    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));

    // dispose must clear the timer without throwing
    expect(() => backend.dispose()).not.toThrow();
  });

  test("supportsDefaultDenyMarker passes through from local backend", async () => {
    const localBackend: PermissionBackend = {
      check: () => ALLOW,
      supportsDefaultDenyMarker: true,
    };

    const backend = createNexusPermissionBackend({
      transport: makeTransport(async () => notFoundResult()),
      localBackend,
      getCurrentPolicy: () => ({}),
      rebuildBackend: () => makeLocalBackend(),
      syncIntervalMs: 0,
    });

    expect(backend.supportsDefaultDenyMarker).toBe(true);
    backend.dispose();
  });
});
