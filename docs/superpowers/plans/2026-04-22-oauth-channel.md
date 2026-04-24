# OAuthChannel Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify nexus and MCP OAuth into a single `OAuthChannel` protocol (L0), with inline pause-and-retry for MCP 401s and no-restart tool reload after auth completes.

**Architecture:** Add `OAuthChannel` interface to `@koi/core` (L0); refactor `@koi/fs-nexus` and `@koi/mcp` to emit through it; implement the single concrete renderer in `@koi-agent/cli`; wire one instance through TUI boot replacing the duplicate `/mcp`-view auth block.

**Tech Stack:** Bun 1.3, TypeScript 6 strict, `bun:test`, ESM `.js` extensions, `import type` for type-only imports.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/kernel/core/src/oauth-channel.ts` | Create | `OAuthChannel` interface + notification types |
| `packages/kernel/core/src/index.ts` | Modify | Export new types |
| `packages/lib/fs-nexus/src/auth-notifications.ts` | Modify | Accept `OAuthChannel + ChannelAdapter`; delegate required/complete to channel |
| `packages/lib/fs-nexus/src/auth-notifications.test.ts` | Modify | Update tests for new signature |
| `packages/net/mcp/src/connection.ts` | Modify | Add `onAuthNeeded?: () => Promise<boolean>` to `ConnectionDeps`; retry on 401 |
| `packages/net/mcp/src/connection.test.ts` | Modify / Create | Test pause-and-retry behavior |
| `packages/meta/cli/src/oauth-channel.ts` | Create | `createOAuthChannel` factory — single renderer for both flows |
| `packages/meta/cli/src/oauth-channel.test.ts` | Create | Unit tests for factory |
| `packages/meta/cli/src/mcp-connection-factory.ts` | Modify | Wire `oauthChannel` + `onAuthNeeded` into connection |
| `packages/meta/cli/src/shared-wiring.ts` | Modify | Accept + pass `OAuthChannel` to every `createOAuthAwareMcpConnection` call |
| `packages/meta/cli/src/tui-command.ts` | Modify | Create one `OAuthChannel`, wire to nexus + MCP, remove `/mcp`-view auth block |

---

## Task 1: L0 interface — `OAuthChannel` in `@koi/core`

**Files:**
- Create: `packages/kernel/core/src/oauth-channel.ts`
- Modify: `packages/kernel/core/src/index.ts`

- [ ] **Step 1: Write the new L0 file**

Create `packages/kernel/core/src/oauth-channel.ts`:

```typescript
/**
 * Shared OAuth authorization channel protocol.
 *
 * Both nexus bridge and MCP connections emit through this interface.
 * The CLI wires a single concrete implementation that renders inline
 * chat messages and routes `submitAuthCode` to the appropriate transport.
 */

/**
 * Emitted when a provider requires OAuth authorization.
 *
 * `authUrl` is optional — nexus always supplies it (user may need to
 * paste it manually in remote mode); MCP omits it because the browser
 * opens automatically via the local callback server.
 */
export interface AuthRequiredNotification {
  readonly provider: string;
  readonly authUrl?: string | undefined;
  readonly message: string;
  /** "local" — loopback callback handles code exchange automatically.
   *  "remote" — user must paste the full redirect URL back into chat. */
  readonly mode: "local" | "remote";
  readonly correlationId?: string | undefined;
  readonly instructions?: string | undefined;
}

/** Emitted when OAuth authorization completes successfully. */
export interface AuthCompleteNotification {
  readonly provider: string;
}

/**
 * Shared protocol for OAuth authorization UX.
 *
 * Producers (nexus transport, MCP connection) call `onAuthRequired` /
 * `onAuthComplete` as side effects during the auth lifecycle.
 * The CLI's `createOAuthChannel` factory is the single concrete implementation.
 */
export interface OAuthChannel {
  readonly onAuthRequired: (n: AuthRequiredNotification) => void;
  readonly onAuthComplete: (n: AuthCompleteNotification) => void;
  /** Forward a pasted redirect URL to the transport (remote mode only). */
  readonly submitAuthCode: (redirectUrl: string, correlationId?: string) => void;
}
```

- [ ] **Step 2: Export from `@koi/core` index**

In `packages/kernel/core/src/index.ts`, add before the `// workspace` section (find the line `// workspace — workspace isolation contract types` and insert above it):

```typescript
// oauth-channel — shared OAuth authorization channel protocol
export type {
  AuthCompleteNotification,
  AuthRequiredNotification,
  OAuthChannel,
} from "./oauth-channel.js";
```

- [ ] **Step 3: Run typecheck to verify L0 compiles with zero deps**

```bash
cd /path/to/worktree && bun run typecheck --filter=@koi/core
```

Expected: no errors. The file has no `import` statements — it must stay that way.

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/core/src/oauth-channel.ts packages/kernel/core/src/index.ts
git commit -m "feat(core): add OAuthChannel interface + notification types to L0 (#1982)"
```

---

## Task 2: `@koi/fs-nexus` — route `auth_required`/`auth_complete` through `OAuthChannel`

**Files:**
- Modify: `packages/lib/fs-nexus/src/auth-notifications.ts`
- Modify: `packages/lib/fs-nexus/src/auth-notifications.test.ts`

- [ ] **Step 1: Write failing tests for new signature**

Replace the existing `describe("createAuthNotificationHandler", ...)` block in `packages/lib/fs-nexus/src/auth-notifications.test.ts`. The key change: factory now takes `(oauthChannel, channel)` instead of `(channel)`.

Add these tests (keep existing ones, updating the factory call site):

```typescript
import { describe, expect, mock, test } from "bun:test";
import type { OAuthChannel } from "@koi/core";
import { createAuthNotificationHandler } from "./auth-notifications.js";
import type { BridgeNotification } from "./types.js";

function makeOAuthChannel() {
  const required: Array<{ provider: string; authUrl?: string; mode: string }> = [];
  const completed: Array<{ provider: string }> = [];
  const submitted: Array<string> = [];
  const channel: OAuthChannel = {
    onAuthRequired: mock((n) => { required.push(n); }),
    onAuthComplete: mock((n) => { completed.push(n); }),
    submitAuthCode: mock((url) => { submitted.push(url); }),
  };
  return { channel, required, completed, submitted };
}

function makeChannelAdapter(sendImpl?: () => Promise<void>) {
  const sent: Array<{ content: readonly unknown[] }> = [];
  return {
    adapter: {
      send: mock(async (msg: { content: readonly unknown[] }) => {
        sent.push(msg);
        await (sendImpl?.() ?? Promise.resolve());
      }),
      connect: mock(async () => {}),
      disconnect: mock(async () => {}),
      onMessage: mock(() => () => {}),
      capabilities: { streaming: false as const },
      name: "test-channel",
    },
    sent,
  };
}

describe("createAuthNotificationHandler — auth_required routes through OAuthChannel", () => {
  test("calls onAuthRequired with correct fields", () => {
    const { channel, required } = makeOAuthChannel();
    const { adapter } = makeChannelAdapter();
    const handler = createAuthNotificationHandler(channel, adapter as never);
    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_required",
      params: {
        provider: "gdrive",
        user_email: "user@example.com",
        auth_url: "https://accounts.google.com/o/oauth2/auth?...",
        message: "Authorize Google Drive",
        mode: "local",
      },
    };
    handler(n);
    expect(required).toHaveLength(1);
    expect(required[0]?.provider).toBe("gdrive");
    expect(required[0]?.authUrl).toBe("https://accounts.google.com/o/oauth2/auth?...");
    expect(required[0]?.mode).toBe("local");
  });

  test("calls onAuthComplete on auth_complete", () => {
    const { channel, completed } = makeOAuthChannel();
    const { adapter } = makeChannelAdapter();
    const handler = createAuthNotificationHandler(channel, adapter as never);
    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_complete",
      params: { provider: "gdrive", user_email: "user@example.com" },
    };
    handler(n);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.provider).toBe("gdrive");
  });

  test("auth_progress still sends via ChannelAdapter (not OAuthChannel)", async () => {
    const { channel } = makeOAuthChannel();
    const { adapter, sent } = makeChannelAdapter();
    const handler = createAuthNotificationHandler(channel, adapter as never);
    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_progress",
      params: { provider: "gdrive", elapsed_seconds: 10, message: "Waiting for authorization" },
    };
    handler(n);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(channel.onAuthRequired).not.toHaveBeenCalled();
    expect(channel.onAuthComplete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun run test --filter=@koi/fs-nexus 2>&1 | grep -E "FAIL|PASS|error" | head -20
```

Expected: FAIL — `createAuthNotificationHandler` still takes `(channel)` only.

- [ ] **Step 3: Update `createAuthNotificationHandler` signature**

In `packages/lib/fs-nexus/src/auth-notifications.ts`, change the import and function signature:

Add to imports at top:
```typescript
import type { OAuthChannel } from "@koi/core";
```

Change function signature from:
```typescript
export function createAuthNotificationHandler(channel: ChannelAdapter): AuthNotificationHandler {
```
to:
```typescript
export function createAuthNotificationHandler(
  oauthChannel: OAuthChannel,
  channel: ChannelAdapter,
): AuthNotificationHandler {
```

In the `auth_required` branch, replace the `void channel.send(...)` block with:
```typescript
    if (n.method === "auth_required") {
      cancelWatchdogsForProvider(n.params.provider);
      progressState.delete(n.params.provider);
      bumpEpoch(n.params.provider);
      const { provider, auth_url, message, mode, instructions, correlation_id } = n.params;
      oauthChannel.onAuthRequired({
        provider,
        authUrl: auth_url,
        message,
        mode,
        correlationId: correlation_id,
        instructions,
      });
```

In the `auth_complete` branch, replace the `void channel.send(...)` block with:
```typescript
    } else if (n.method === "auth_complete") {
      cancelWatchdogsForProvider(n.params.provider);
      progressState.delete(n.params.provider);
      bumpEpoch(n.params.provider);
      oauthChannel.onAuthComplete({ provider: n.params.provider });
```

The `auth_progress` branch is unchanged — it still uses `channel.send(...)`.

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun run test --filter=@koi/fs-nexus 2>&1 | grep -E "FAIL|PASS|pass|fail" | tail -5
```

Expected: all tests in `auth-notifications.test.ts` pass.

- [ ] **Step 5: Typecheck `@koi/fs-nexus`**

```bash
bun run typecheck --filter=@koi/fs-nexus
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/lib/fs-nexus/src/auth-notifications.ts packages/lib/fs-nexus/src/auth-notifications.test.ts
git commit -m "feat(fs-nexus): route auth_required/auth_complete through OAuthChannel (#1982)"
```

---

## Task 3: `@koi/mcp` connection — pause-and-retry on 401

**Files:**
- Modify: `packages/net/mcp/src/connection.ts`
- Modify: `packages/net/mcp/src/index.ts` (re-export `ConnectionDeps` update is automatic)

- [ ] **Step 1: Write failing test for pause-and-retry**

Find or create `packages/net/mcp/src/connection.test.ts`. Add:

```typescript
import { describe, expect, mock, test } from "bun:test";
import { createMcpConnection } from "./connection.js";

// Minimal stubs for connection deps
function makeTransportStub(failWith401 = false) {
  return {
    start: mock(async () => {
      if (failWith401) throw Object.assign(new Error("HTTP 401 Unauthorized"), { code: 401 });
    }),
    close: mock(async () => {}),
    send: mock(async () => ({})),
  };
}

describe("createMcpConnection — onAuthNeeded pause-and-retry", () => {
  test("calls onAuthNeeded when callTool returns AUTH_REQUIRED, retries if true", async () => {
    let callCount = 0;
    const onAuthNeeded = mock(async (): Promise<boolean> => true);

    const conn = createMcpConnection(
      { name: "test-server", kind: "http", url: "http://localhost:9999" } as never,
      undefined,
      {
        onAuthNeeded,
        createClient: mock(() => ({
          connect: mock(async () => {}),
          listTools: mock(async () => ({ tools: [] })),
          callTool: mock(async () => {
            callCount += 1;
            if (callCount === 1) {
              // First call: 401
              throw Object.assign(new Error("HTTP 401 Unauthorized"), {});
            }
            // Second call: success
            return { content: [{ type: "text", text: "ok" }], isError: false };
          }),
        })) as never,
        createTransport: mock(() => ({
          start: mock(async () => {}),
          close: mock(async () => {}),
        })) as never,
        random: () => 0,
      },
    );

    // First connect
    await conn.connect();

    const result = await conn.callTool("some_tool", {});
    expect(onAuthNeeded).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  test("returns AUTH_REQUIRED error when onAuthNeeded returns false", async () => {
    const onAuthNeeded = mock(async (): Promise<boolean> => false);

    const conn = createMcpConnection(
      { name: "test-server", kind: "http", url: "http://localhost:9999" } as never,
      undefined,
      {
        onAuthNeeded,
        createClient: mock(() => ({
          connect: mock(async () => {}),
          listTools: mock(async () => ({ tools: [] })),
          callTool: mock(async () => {
            throw Object.assign(new Error("HTTP 401 Unauthorized"), {});
          }),
        })) as never,
        createTransport: mock(() => ({
          start: mock(async () => {}),
          close: mock(async () => {}),
        })) as never,
        random: () => 0,
      },
    );

    await conn.connect();
    const result = await conn.callTool("some_tool", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTH_REQUIRED");
  });

  test("returns AUTH_REQUIRED error without retry when no onAuthNeeded handler", async () => {
    const conn = createMcpConnection(
      { name: "test-server", kind: "http", url: "http://localhost:9999" } as never,
      undefined,
      {
        createClient: mock(() => ({
          connect: mock(async () => {}),
          listTools: mock(async () => ({ tools: [] })),
          callTool: mock(async () => {
            throw Object.assign(new Error("HTTP 401 Unauthorized"), {});
          }),
        })) as never,
        createTransport: mock(() => ({
          start: mock(async () => {}),
          close: mock(async () => {}),
        })) as never,
        random: () => 0,
      },
    );

    await conn.connect();
    const result = await conn.callTool("some_tool", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTH_REQUIRED");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun run test --filter=@koi/mcp 2>&1 | grep -E "connection.test|FAIL|PASS" | head -10
```

Expected: FAIL — `onAuthNeeded` does not exist yet.

- [ ] **Step 3: Add `onAuthNeeded` to `ConnectionDeps`**

In `packages/net/mcp/src/connection.ts`, find the `ConnectionDeps` interface (line ~88) and add:

```typescript
export interface ConnectionDeps {
  readonly createClient: (info: {
    readonly name: string;
    readonly version: string;
  }) => SdkClientLike;
  readonly createTransport: CreateTransportFn;
  readonly random: () => number;
  /** Called when a mid-session 401/403 triggers auth-needed. Use to clear stale tokens. */
  readonly onUnauthorized?: () => void | Promise<void>;
  /**
   * Called when a 401 is received on a tool call. If provided and returns `true`,
   * the tool call is retried once with a fresh token. If `false` or absent,
   * AUTH_REQUIRED is returned immediately.
   */
  readonly onAuthNeeded?: () => Promise<boolean>;
}
```

Also destructure it in the factory:
```typescript
  const {
    createClient: makeClient = defaultCreateClient,
    createTransport: makeTransport = defaultCreateTransport,
    random = Math.random,
    onUnauthorized,
    onAuthNeeded,
  } = deps ?? {};
```

- [ ] **Step 4: Wire pause-and-retry in `callTool`**

Find the `callTool` method's `AUTH_REQUIRED` catch block (around line 449). Change:

```typescript
      if (koiError.code === "AUTH_REQUIRED" && stateMachine.canTransitionTo("auth-needed")) {
        stateMachine.transition({
          kind: "auth-needed",
          challenge: { type: "oauth" },
        });
        // Notify host to clear stale tokens and prompt for re-auth
        void Promise.resolve(onUnauthorized?.()).catch(() => {});
        return { ok: false, error: koiError };
      }
```

to:

```typescript
      if (koiError.code === "AUTH_REQUIRED" && stateMachine.canTransitionTo("auth-needed")) {
        stateMachine.transition({
          kind: "auth-needed",
          challenge: { type: "oauth" },
        });
        void Promise.resolve(onUnauthorized?.()).catch(() => {});
        // Pause and retry if the host can handle auth inline.
        if (onAuthNeeded !== undefined) {
          const authed = await onAuthNeeded().catch(() => false);
          if (authed) {
            // Auth succeeded — reconnect and retry the tool call once.
            const reconnResult = await ensureConnected();
            if (!reconnResult.ok) return reconnResult;
            if (client === undefined) return { ok: false, error: notConnectedError(config.name) };
            try {
              const retryResult = await client.callTool({
                name,
                arguments: args as Record<string, unknown>,
              });
              const retryContent = retryResult.content as readonly Record<string, unknown>[] | undefined;
              return { ok: true, value: retryContent };
            } catch {
              return { ok: false, error: koiError };
            }
          }
        }
        return { ok: false, error: koiError };
      }
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
bun run test --filter=@koi/mcp 2>&1 | grep -E "FAIL|PASS|pass|fail" | tail -5
```

Expected: connection.test passes; no existing tests broken.

- [ ] **Step 6: Typecheck**

```bash
bun run typecheck --filter=@koi/mcp
```

- [ ] **Step 7: Commit**

```bash
git add packages/net/mcp/src/connection.ts packages/net/mcp/src/connection.test.ts
git commit -m "feat(mcp): add onAuthNeeded callback — pause-and-retry on 401 (#1982)"
```

---

## Task 4: CLI — `createOAuthChannel` factory

**Files:**
- Create: `packages/meta/cli/src/oauth-channel.ts`
- Create: `packages/meta/cli/src/oauth-channel.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/meta/cli/src/oauth-channel.test.ts`:

```typescript
import { describe, expect, mock, test } from "bun:test";
import { createOAuthChannel } from "./oauth-channel.js";

function makeChannelAdapter() {
  const sent: Array<{ content: readonly { kind: string; text: string }[] }> = [];
  return {
    adapter: {
      send: mock(async (msg: { content: readonly { kind: string; text: string }[] }) => {
        sent.push(msg);
      }),
      connect: mock(async () => {}),
      disconnect: mock(async () => {}),
      onMessage: mock(() => () => {}),
      capabilities: { streaming: false as const },
      name: "test-channel",
    },
    sent,
  };
}

describe("createOAuthChannel", () => {
  test("onAuthRequired sends inline chat message with authUrl", async () => {
    const { adapter, sent } = makeChannelAdapter();
    const ch = createOAuthChannel({ channel: adapter as never });
    ch.onAuthRequired({
      provider: "gdrive",
      authUrl: "https://accounts.google.com/auth",
      message: "Authorize Google Drive",
      mode: "local",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    const text = sent[0]?.content[0];
    expect(text?.kind).toBe("text");
    expect(text?.text).toContain("gdrive");
    expect(text?.text).toContain("https://accounts.google.com/auth");
  });

  test("onAuthRequired with no authUrl still sends message (MCP local mode)", async () => {
    const { adapter, sent } = makeChannelAdapter();
    const ch = createOAuthChannel({ channel: adapter as never });
    ch.onAuthRequired({
      provider: "linear",
      message: "Authorize Linear",
      mode: "local",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    const text = sent[0]?.content[0];
    expect(text?.kind).toBe("text");
    expect(text?.text).toContain("linear");
  });

  test("onAuthComplete sends completion message", async () => {
    const { adapter, sent } = makeChannelAdapter();
    const ch = createOAuthChannel({ channel: adapter as never });
    ch.onAuthComplete({ provider: "gdrive" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content[0]?.text).toContain("gdrive");
    expect(sent[0]?.content[0]?.text).toContain("complete");
  });

  test("submitAuthCode calls onSubmit with url and correlationId", () => {
    const onSubmit = mock((_url: string, _id?: string) => {});
    const { adapter } = makeChannelAdapter();
    const ch = createOAuthChannel({ channel: adapter as never, onSubmit });
    ch.submitAuthCode("http://localhost:8080/callback?code=abc", "corr-1");
    expect(onSubmit).toHaveBeenCalledWith("http://localhost:8080/callback?code=abc", "corr-1");
  });

  test("submitAuthCode is no-op when onSubmit not provided", () => {
    const { adapter } = makeChannelAdapter();
    const ch = createOAuthChannel({ channel: adapter as never });
    // Must not throw
    ch.submitAuthCode("http://localhost:8080/callback?code=abc");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun run test --filter=@koi-agent/cli packages/meta/cli/src/oauth-channel.test.ts 2>&1 | grep -E "FAIL|error" | head -5
```

Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement the factory**

Create `packages/meta/cli/src/oauth-channel.ts`:

```typescript
import type { ChannelAdapter } from "@koi/core";
import type {
  AuthCompleteNotification,
  AuthRequiredNotification,
  OAuthChannel,
} from "@koi/core";

export interface OAuthChannelOptions {
  readonly channel: ChannelAdapter;
  /**
   * Called by `submitAuthCode` — wire to `nexusTransport.submitAuthCode` for nexus.
   * Omit for MCP (loopback callback server handles code exchange autonomously).
   */
  readonly onSubmit?: ((redirectUrl: string, correlationId?: string) => void) | undefined;
}

/** Strip query params from OAuth URLs before logging (anti-CSRF state, account ids). */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "[unparseable URL]";
  }
}

export function createOAuthChannel(options: OAuthChannelOptions): OAuthChannel {
  const { channel, onSubmit } = options;

  const onAuthRequired = (n: AuthRequiredNotification): void => {
    const urlLine =
      n.authUrl !== undefined ? `\n\nOpen this link in your browser to authorize ${n.provider}:\n${n.authUrl}` : "";
    const remoteLine =
      n.mode === "remote" && n.instructions !== undefined ? `\n\n_${n.instructions}_` : "";
    void channel
      .send({
        content: [
          {
            kind: "text",
            text: `**${n.message}**${urlLine}${remoteLine}`,
          },
        ],
      })
      .catch((err: unknown) => {
        console.error(
          `[koi/oauth-channel] Failed to deliver auth_required for ${n.provider}: ${String(err)}. ` +
            (n.authUrl !== undefined ? `Redacted URL: ${redactUrl(n.authUrl)}` : ""),
        );
      });
  };

  const onAuthComplete = (n: AuthCompleteNotification): void => {
    void channel
      .send({
        content: [
          {
            kind: "text",
            text: `${n.provider} authorization complete. Continuing...`,
          },
        ],
      })
      .catch(() => {
        // Decorative — operation will succeed regardless
      });
  };

  const submitAuthCode = (redirectUrl: string, correlationId?: string): void => {
    onSubmit?.(redirectUrl, correlationId);
  };

  return { onAuthRequired, onAuthComplete, submitAuthCode };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun run test --filter=@koi-agent/cli packages/meta/cli/src/oauth-channel.test.ts 2>&1 | tail -5
```

Expected: all 5 tests pass.

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck --filter=@koi-agent/cli
```

- [ ] **Step 6: Commit**

```bash
git add packages/meta/cli/src/oauth-channel.ts packages/meta/cli/src/oauth-channel.test.ts
git commit -m "feat(cli): add createOAuthChannel — single renderer for nexus + MCP auth (#1982)"
```

---

## Task 5: CLI — wire `OAuthChannel` into `mcp-connection-factory`

**Files:**
- Modify: `packages/meta/cli/src/mcp-connection-factory.ts`

- [ ] **Step 1: Read the current file**

```bash
cat packages/meta/cli/src/mcp-connection-factory.ts
```

The file currently exports `createOAuthAwareMcpConnection(server, authProviderSink?)`. We will add `oauthChannel?: OAuthChannel`.

- [ ] **Step 2: Update `createOAuthAwareMcpConnection`**

Replace the entire file content with:

```typescript
/**
 * OAuth-aware MCP connection factory.
 *
 * Wraps createMcpConnection to automatically attach an OAuthAuthProvider
 * when the server config has an `oauth` field.
 * Used by shared-wiring, start command, and mcp CLI commands.
 */

import type { OAuthChannel } from "@koi/core";
import type { McpConnection, McpServerConfig, OAuthAuthProvider } from "@koi/mcp";
import { createMcpConnection, createOAuthAuthProvider, resolveServerConfig } from "@koi/mcp";
import { createSecureStorage } from "@koi/secure-storage";
import { createCliOAuthRuntime } from "./commands/mcp-oauth-runtime.js";

/**
 * Creates an MCP connection, attaching an OAuth auth provider when the
 * server config includes an `oauth` field.
 *
 * When `authProviderSink` is provided, stores the auth provider keyed
 * by server name so the auth tool factory can access it later.
 *
 * When `oauthChannel` is provided, mid-session 401s trigger an inline
 * auth prompt and the tool call is retried automatically after success.
 */
export function createOAuthAwareMcpConnection(
  server: McpServerConfig,
  authProviderSink?: Map<string, OAuthAuthProvider>,
  oauthChannel?: OAuthChannel,
): McpConnection {
  const resolved = resolveServerConfig(server);

  if (server.kind === "http" && server.oauth !== undefined) {
    const storage = createSecureStorage();
    const runtime = createCliOAuthRuntime();
    const provider = createOAuthAuthProvider({
      serverName: server.name,
      serverUrl: server.url,
      oauthConfig: server.oauth,
      runtime,
      storage,
    });

    authProviderSink?.set(server.name, provider);

    const onAuthNeeded =
      oauthChannel !== undefined
        ? async (): Promise<boolean> => {
            oauthChannel.onAuthRequired({
              provider: server.name,
              message: `${server.name} requires authorization`,
              mode: "local",
            });
            const success = await provider.startAuthFlow().catch(() => false);
            if (success) {
              oauthChannel.onAuthComplete({ provider: server.name });
            }
            return success;
          }
        : undefined;

    return createMcpConnection(resolved, provider, {
      onUnauthorized: () => provider.handleUnauthorized(),
      onAuthNeeded,
    });
  }

  return createMcpConnection(resolved);
}
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck --filter=@koi-agent/cli
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/meta/cli/src/mcp-connection-factory.ts
git commit -m "feat(cli): wire OAuthChannel + onAuthNeeded into mcp-connection-factory (#1982)"
```

---

## Task 6: CLI — pass `OAuthChannel` through `shared-wiring`

**Files:**
- Modify: `packages/meta/cli/src/shared-wiring.ts`

- [ ] **Step 1: Find the two `createOAuthAwareMcpConnection` call sites**

```bash
grep -n "createOAuthAwareMcpConnection" packages/meta/cli/src/shared-wiring.ts
```

Expected: lines ~197 and ~268.

- [ ] **Step 2: Update `McpSetup` and the wiring function signature**

`shared-wiring.ts` exports `buildMcpSetup` (or similar function names — check exact names). Find the exported function(s) that build `McpSetup` and add `oauthChannel?: OAuthChannel` to their options parameter. Then thread it through to each `createOAuthAwareMcpConnection` call.

Add import at top:
```typescript
import type { OAuthChannel } from "@koi/core";
```

For each function that calls `createOAuthAwareMcpConnection`, update the call:
```typescript
// Before:
const conn = createOAuthAwareMcpConnection(server, authProviders);
// After:
const conn = createOAuthAwareMcpConnection(server, authProviders, oauthChannel);
```

The function signature change depends on the exact function name. Check:
```bash
grep -n "^export.*function\|^export.*async function\|^export.*const" packages/meta/cli/src/shared-wiring.ts | head -10
```

Add `oauthChannel?: OAuthChannel` to the options object of those functions.

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck --filter=@koi-agent/cli
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/meta/cli/src/shared-wiring.ts
git commit -m "feat(cli): thread OAuthChannel through shared-wiring (#1982)"
```

---

## Task 7: TUI — single `OAuthChannel` instance, remove duplicate `/mcp` auth block

**Files:**
- Modify: `packages/meta/cli/src/tui-command.ts`

This is the largest change. Work in three sub-steps.

- [ ] **Step 1: Add `OAuthChannel` import and create instance**

Near the top of `tui-command.ts`, add to imports:
```typescript
import { createOAuthChannel } from "./oauth-channel.js";
```

Remove the existing import of `createAuthNotificationHandler` from `@koi/fs-nexus` (it's still used, but the call site changes below).

Find the section where `tuiChannelForAuth` is defined (around line 1340 — the section with the comment about nexus auth loop). After `tuiChannelForAuth` is set up, add:

```typescript
  // Single OAuthChannel — wired to both nexus and MCP.
  // submitAuthCode is populated below once nexus transport is resolved.
  // let: justified — populated after transport is resolved in nexus boot path
  let tuiOAuthChannel: import("@koi/core").OAuthChannel | undefined;
```

Then, where `tuiAuthNotificationHandler` is currently created (around line 1407):

```typescript
  // Before:
  let tuiAuthNotificationHandler: ReturnType<typeof createAuthNotificationHandler> | undefined;
  if (manifestFilesystemConfig !== undefined) {
    tuiAuthNotificationHandler = createAuthNotificationHandler(tuiChannelForAuth);
```

Change to:

```typescript
  let tuiAuthNotificationHandler: ReturnType<typeof createAuthNotificationHandler> | undefined;
  if (manifestFilesystemConfig !== undefined) {
    // submitAuthCode is a let-slot: populated once the nexus transport resolves.
    // let: justified — nexus transport may not exist (HTTP transport has no submitAuthCode)
    let nexusSubmitAuthCode: ((url: string, correlationId?: string) => void) | undefined;
    tuiOAuthChannel = createOAuthChannel({
      channel: tuiChannelForAuth,
      onSubmit: (url, correlationId) => nexusSubmitAuthCode?.(url, correlationId),
    });
    tuiAuthNotificationHandler = createAuthNotificationHandler(
      tuiOAuthChannel,
      tuiChannelForAuth,
    );
    const fsResolved = await resolveFileSystemAsync(
      manifestFilesystemConfig,
      process.cwd(),
      tuiAuthNotificationHandler,
    );
    // ... (existing code follows)
    if (fsResolved.transport !== undefined) {
      const transport = fsResolved.transport;
      nexusSubmitAuthCode = (url, id) => transport.submitAuthCode(url, id);
      // ... (existing correlation_id subscription follows)
    }
```

(The existing `tuiAuthInterceptor` wiring to `createAuthInterceptor(transport)` stays unchanged — it feeds into `tuiOAuthChannel.submitAuthCode` via `nexusSubmitAuthCode`.)

- [ ] **Step 2: Wire `tuiOAuthChannel` to MCP wiring**

Find where `buildMcpSetup` (or equivalent function from `shared-wiring`) is called in `tui-command.ts`. Add `oauthChannel: tuiOAuthChannel` to the options.

Also update any direct calls to `createOAuthAwareMcpConnection` if present (there shouldn't be, since MCP goes through `shared-wiring`).

- [ ] **Step 3: Remove the duplicate `/mcp`-view Enter-to-auth block**

Find the `/mcp` Enter auth block (around line 4190, starting with `// Triggered by pressing Enter on a needs-auth server in /mcp view`). This block currently:
1. Creates `createCliOAuthRuntime()` + `createOAuthAuthProvider()`
2. Calls `provider.startAuthFlow()`
3. Dispatches `set_mcp_status` with `auth-pending-restart`

Replace the entire `try { ... } catch { ... } finally { ... }` block inside `void (async () => { ... })()` with:

```typescript
void (async (): Promise<void> => {
  const rawName = args.trim();
  if (rawName === "") return;
  if (rawName.startsWith("plugin:")) {
    store.dispatch({
      kind: "add_error",
      code: "MCP_AUTH",
      message:
        `Cannot authenticate "${rawName}" from /mcp — plugin-provided ` +
        `servers must be authenticated through the plugin's own flow.`,
    });
    return;
  }
  const serverName = rawName.startsWith("user:") ? rawName.slice(5) : rawName;
  if (mcpAuthInFlight.has(serverName)) return;
  mcpAuthInFlight.add(serverName);
  try {
    if (tuiOAuthChannel !== undefined) {
      // Re-surface the auth prompt inline — same path as tool-call-triggered auth.
      tuiOAuthChannel.onAuthRequired({
        provider: serverName,
        message: `${serverName} requires authorization`,
        mode: "local",
      });
    }
    // The connection's onAuthNeeded handler will call startAuthFlow() and
    // onAuthComplete() automatically on the next tool call. If the user
    // wants to pre-auth before a tool call, they can initiate a query that
    // uses the server's tools — the connection will handle the flow inline.
  } finally {
    mcpAuthInFlight.delete(serverName);
  }
})();
```

Also remove the `auth-pending-restart` status type usage — the connection now reconnects inline, so it transitions to `connected` after `startAuthFlow()` succeeds.

- [ ] **Step 4: Run full test suite**

```bash
bun run test 2>&1 | tail -15
```

Expected: 209 pass, 12 pre-existing nexus-fs failures (unchanged). Zero new failures.

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Layer check**

```bash
bun run check:layers
```

Expected: no violations. `@koi/core` has no new imports; `@koi/fs-nexus` and `@koi/mcp` only import from `@koi/core`.

- [ ] **Step 7: Commit**

```bash
git add packages/meta/cli/src/tui-command.ts
git commit -m "feat(cli): wire single OAuthChannel to nexus + MCP; remove /mcp duplicate auth (#1982)"
```

---

## Task 8: Integration test — MCP OAuth inline flow

**Files:**
- Modify: `packages/net/mcp/src/connection.test.ts` (extend from Task 3)

This task adds a full-flow integration test that verifies the complete path: `callTool` → `AUTH_REQUIRED` → `onAuthNeeded` → `onAuthRequired` called on `OAuthChannel` → `onAuthComplete` called → retry succeeds.

- [ ] **Step 1: Write the integration test**

Add to `packages/net/mcp/src/connection.test.ts`:

```typescript
import type { OAuthChannel } from "@koi/core";

describe("MCP OAuth inline flow — full path", () => {
  test("onAuthRequired fires, onAuthComplete fires, tool call retries after success", async () => {
    const authRequired: string[] = [];
    const authComplete: string[] = [];
    const oauthChannel: OAuthChannel = {
      onAuthRequired: (n) => { authRequired.push(n.provider); },
      onAuthComplete: (n) => { authComplete.push(n.provider); },
      submitAuthCode: () => {},
    };

    let callCount = 0;
    const conn = createMcpConnection(
      { name: "linear", kind: "http", url: "https://mcp.linear.app" } as never,
      undefined,
      {
        onAuthNeeded: async () => {
          // Simulates: oauthChannel.onAuthRequired was already called by mcp-connection-factory.
          // Here we just call it directly to test the full path.
          oauthChannel.onAuthRequired({ provider: "linear", message: "Authorize Linear", mode: "local" });
          // Simulate successful auth
          oauthChannel.onAuthComplete({ provider: "linear" });
          return true;
        },
        createClient: mock(() => ({
          connect: mock(async () => {}),
          listTools: mock(async () => ({ tools: [] })),
          callTool: mock(async () => {
            callCount += 1;
            if (callCount === 1) throw Object.assign(new Error("HTTP 401 Unauthorized"), {});
            return { content: [{ type: "text", text: "tool result" }], isError: false };
          }),
        })) as never,
        createTransport: mock(() => ({
          start: mock(async () => {}),
          close: mock(async () => {}),
        })) as never,
        random: () => 0,
      },
    );

    await conn.connect();
    const result = await conn.callTool("list_issues", {});

    expect(result.ok).toBe(true);
    expect(authRequired).toEqual(["linear"]);
    expect(authComplete).toEqual(["linear"]);
    expect(callCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test**

```bash
bun run test --filter=@koi/mcp packages/net/mcp/src/connection.test.ts 2>&1 | tail -10
```

Expected: all tests pass including the new integration test.

- [ ] **Step 3: Run full CI gates**

```bash
bun run test && bun run typecheck && bun run lint && bun run check:layers
```

Expected: all pass. 12 pre-existing `@koi/fs-nexus` nexus-fs failures still present (unchanged, require live nexus service).

- [ ] **Step 4: Final commit**

```bash
git add packages/net/mcp/src/connection.test.ts
git commit -m "test(mcp): integration test for OAuthChannel inline flow — AUTH_REQUIRED → retry (#1982)"
```

---

## Self-Review Checklist

- [x] Spec Section 1 (L0 interface) → Task 1
- [x] Spec Section 2 (nexus producer) → Task 2
- [x] Spec Section 2 (MCP producer + onAuthNeeded) → Task 3 + Task 5
- [x] Spec Section 3 (CLI factory) → Task 4
- [x] Spec Section 3 (TUI wiring) → Task 7
- [x] Spec Section 4 (error handling: fire-and-forget, retry cap) → Task 3 step 4 (`catch(() => false)`)
- [x] Acceptance: single OAuthChannel in core → Task 1
- [x] Acceptance: both route auth_required through it → Task 2 + Task 5
- [x] Acceptance: TUI one renderer → Task 4 + Task 7
- [x] Acceptance: no-restart → Task 3 (retry in callTool) + Task 7 (remove auth-pending-restart)
- [x] Golden/integration test → Task 8
- [x] Layer check in CI → Task 7 Step 6
