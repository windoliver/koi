# OAuthChannel Unification — Design Spec

**Issue:** #1982  
**Branch:** `issue-1982-oauth-channel`  
**Date:** 2026-04-22  
**Status:** Approved

---

## Problem

Two OAuth flows exist in Koi today with divergent UX and no shared protocol:

| Aspect | Nexus connector OAuth | MCP server OAuth |
|--------|----------------------|------------------|
| Trigger | Tool call hits unauthed nexus provider → `auth_required` bridge notification | User opens `/mcp`, presses Enter on server |
| Prompt surface | Inline chat message with URL | `/mcp` overlay panel |
| Post-auth | Auto-retry same tool call | **"auth-pending-restart"** — TUI restart required |
| Renderer | `createAuthNotificationHandler` → `ChannelAdapter` | Inline block in `tui-command.ts` |
| Shared protocol | None — `BridgeNotification` is nexus-specific | None — MCP runs its own `startAuthFlow()` |

Both use PKCE S256 + state CSRF + Fernet-encrypted tokens + refresh rotation. The protocol is shared; the channel is not.

---

## Goals

1. Single `OAuthChannel` protocol in `@koi/core` (L0)
2. Both nexus and MCP route `auth_required` through it
3. TUI uses one renderer for both surfaces
4. MCP mid-session 401 → inline pause-and-retry (no restart)
5. `/mcp` Enter-to-auth triggers the same inline flow (no separate runtime)

## Non-Goals

- Don't change PKCE, token storage, DCR registration, or `McpAuthProvider.token()`
- Don't remove `/mcp` view — keep it as a status surface (connect/disconnect)
- Don't force nexus into a pre-flight view — inline-on-first-call stays

---

## Architecture

### Section 1 — L0 Interface (`@koi/core`)

New file: `packages/kernel/core/src/oauth-channel.ts`

```typescript
export interface AuthRequiredNotification {
  readonly provider: string;
  readonly authUrl: string;
  readonly message: string;
  readonly mode: "local" | "remote";
  readonly correlationId?: string;
  readonly instructions?: string;
}

export interface AuthCompleteNotification {
  readonly provider: string;
}

export interface OAuthChannel {
  readonly onAuthRequired: (n: AuthRequiredNotification) => void;
  readonly onAuthComplete: (n: AuthCompleteNotification) => void;
  readonly submitAuthCode: (redirectUrl: string, correlationId?: string) => void;
}
```

Exported from `@koi/core`'s existing index. Zero logic, zero deps. Fits L0 rules (pure interface, no function bodies, no imports from other `@koi/*` packages).

`AuthRequiredNotification` is a normalized projection of both:
- `BridgeNotification["auth_required"]["params"]` (nexus) — maps `auth_url` → `authUrl`
- MCP connection `auth-needed` state + server OAuth config — maps `server.name` → `provider`, derives `authUrl` from `startAuthFlow()`

### Section 2 — Producers

**`@koi/fs-nexus`**

`createAuthNotificationHandler` is refactored to accept `OAuthChannel` + `ChannelAdapter`:

```typescript
export function createAuthNotificationHandler(
  oauthChannel: OAuthChannel,
  channel: ChannelAdapter,
): AuthNotificationHandler
```

- `auth_required` / `auth_complete` → delegated to `oauthChannel`. Text formatting (the inline message copy) moves to the CLI's `OAuthChannel` implementation — it's a rendering concern, not a transport concern.
- `auth_progress` → still sent directly via `channel.send(...)` inside `@koi/fs-nexus`. Progress heartbeats are nexus-specific keepalive signals; they don't belong on the shared L0 interface. The dedup/watchdog logic is unchanged.

`oauthChannel.submitAuthCode` delegates to `nexusTransport.submitAuthCode` (wired in `tui-command.ts`).

**`@koi/mcp`**

`createMcpConnection` gains an optional param:

```typescript
oauthChannel?: OAuthChannel
```

When `auth-needed` fires on a 401:
1. Calls `oauthChannel.onAuthRequired(...)` with provider = server name, `authUrl` from `startAuthFlow()`, mode = `"local"` (loopback callback server handles the code exchange autonomously)
2. Stores a `resume()` closure — transitions `auth-needed → connecting`, fetches fresh token, reconnects

After `startAuthFlow()` succeeds (tokens stored):
1. Calls `oauthChannel.onAuthComplete({ provider: serverName })`
2. Calls `resume()` — no restart required, tools become available immediately

### Section 3 — CLI Implementation & TUI Unification

New file: `packages/meta/cli/src/oauth-channel.ts`

```typescript
export function createOAuthChannel(options: {
  readonly channel: ChannelAdapter;
  readonly onSubmit?: (url: string, correlationId?: string) => void;
}): OAuthChannel
```

Single renderer for both nexus and MCP:
- `onAuthRequired` → `channel.send(...)` with URL + message (same copy as today)
- `onAuthComplete` → `channel.send("… authorization complete. Continuing...")`
- `submitAuthCode` → calls `options.onSubmit` (wired to `nexusTransport.submitAuthCode` for nexus; no-op for MCP, which handles the code exchange via its own loopback callback server)

**`createAuthInterceptor` is unchanged.** It detects pasted localhost callback URLs and calls `oauthChannel.submitAuthCode(...)`. Nexus remote mode and MCP remote mode both route through it.

**TUI wiring (`tui-command.ts`):**
- Create one `OAuthChannel` instance after `tuiChannelForAuth` is set up
- Pass it to `resolveFileSystemAsync` (nexus) replacing the `AuthNotificationHandler` path
- Pass it to each `createMcpConnection` call
- Remove the `/mcp`-view Enter-to-auth block's inline `createCliOAuthRuntime()` + `createOAuthAuthProvider()` call — superseded by the connection's `resume()` path
- `mcpAuthInFlight` guard stays — prevents concurrent flows per server
- `/mcp` Enter on `needs-auth` server: calls `oauthChannel.onAuthRequired(...)` directly (same code path as tool-call-triggered auth)

**`/mcp` view status:** `needs-auth` stays as a status label. After `resume()` succeeds, the connection transitions to `connected` and the view refreshes — `auth-pending-restart` is no longer needed.

### Section 4 — Error Handling

- `onAuthRequired` is fire-and-forget. Delivery failure is logged (redacted URL, no query params) but never throws — a failed notification must not abort the agent loop.
- `resume()` after `submitAuthCode`: if token fetch fails, connection transitions back to `auth-needed` and `onAuthRequired` fires again. Natural retry cap via the connection state machine's existing `MAX_RECONNECT_ATTEMPTS`.
- If `startAuthFlow()` times out (2-min loopback callback timeout), `onAuthComplete` is never called — connection stays `auth-needed`. No silent failure; user sees no "authorization complete" message and can retry.
- `mcpAuthInFlight` prevents concurrent flows per server (unchanged).

---

## Testing

| Test | Package | What |
|------|---------|------|
| `OAuthChannel` interface shape | `@koi/core` | Type-only; verified by compilation |
| `createAuthNotificationHandler` with `OAuthChannel` | `@koi/fs-nexus` unit | `onAuthRequired` / `onAuthComplete` called with correct fields; `submitAuthCode` delegates to transport |
| MCP connection `auth-needed` → `onAuthRequired` → `resume()` | `@koi/mcp` unit | Mock `OAuthChannel`; assert call sequence; assert connection transitions to `connecting` after resume |
| No-restart: `startAuthFlow` success → `resume()` called | `@koi/mcp` unit | Extend existing `provider.test.ts` |
| Golden-replay: MCP OAuth inline prompt | `@koi/runtime` golden | New cassette `mcp-oauth` — `AUTH_REQUIRED` → inline channel message → `auth_complete` → tool retried; full ATIF trajectory |

---

## Acceptance Criteria (from issue #1982)

- [ ] Single `OAuthChannel` protocol in `@koi/core`
- [ ] Both nexus and MCP route `auth_required` through it
- [ ] TUI uses one renderer for both surfaces
- [ ] Golden-replay test: MCP server needing OAuth triggers inline prompt, completes via loopback, token cached
- [ ] E2E: nexus + MCP auth flows share same UX (same inline prompt, same "authorization complete" signal)
- [ ] (Added) No-restart: MCP tools available immediately after auth without TUI restart

---

## Files Changed

| File | Change |
|------|--------|
| `packages/kernel/core/src/oauth-channel.ts` | New — `OAuthChannel` interface + notification types |
| `packages/kernel/core/src/index.ts` | Export `oauth-channel` |
| `packages/lib/fs-nexus/src/auth-notifications.ts` | Refactor to accept `OAuthChannel` instead of `ChannelAdapter` |
| `packages/lib/fs-nexus/src/auth-notifications.test.ts` | Update tests |
| `packages/net/mcp/src/connection.ts` | Add `oauthChannel` param; call `onAuthRequired` on 401; expose `resume()` |
| `packages/net/mcp/src/component-provider.ts` | Thread `oauthChannel` through to connection |
| `packages/net/mcp/src/oauth/provider.ts` | Call `onAuthComplete` + `resume()` after `startAuthFlow` success |
| `packages/net/mcp/src/oauth/provider.test.ts` | Extend with resume test |
| `packages/meta/cli/src/oauth-channel.ts` | New — `createOAuthChannel` factory |
| `packages/meta/cli/src/tui-command.ts` | Wire single `OAuthChannel`; remove duplicate `/mcp`-view auth block |
| `packages/meta/cli/src/auth-interceptor.ts` | No change |
| `packages/meta/runtime/scripts/record-cassettes.ts` | Add `mcp-oauth` cassette config |
| `packages/meta/runtime/src/__tests__/golden-replay.test.ts` | Add MCP OAuth golden assertions |
