# Issue #1609 — Extension-injected browser sessions

**Status**: Design approved 2026-04-18
**Owner**: @SophiaWJ
**Issue**: https://github.com/windoliver/koi/issues/1609
**Worktree / branch**: `.claude/worktrees/issue-1609-browser-ext` / `worktree-issue-1609-browser-ext`

---

## 1. Problem

Koi's current `cdpEndpoint` option requires the user to relaunch Chrome with `--remote-debugging-port=9222`. That means:

- Cannot attach to an already-running daily browser.
- Breaks open tabs and logged-in sessions.
- Demands recurring technical setup from the user.

We want an attach path that reaches the user's **live** Chrome — inheriting Gmail / GitHub / SSO / 2FA sessions — without a relaunch.

## 2. Goals and non-goals

**Goals (Phase 1, MVP)**
- One command + one extension install → agent drives the user's live Chrome.
- Zero-restart authentication: agent inherits existing cookies, sessions, 2FA.
- Reuse the existing `BrowserDriver` contract and `@koi/tool-browser` without changes.
- Wire protocol correctness: chunking for oversized payloads, session-scoped correlation, control-frame keepalive.
- Security (Phase 1 minimum — **reduced guarantee**): same-user OS file modes (`0o700`/`0o600`), install-time auth token, Chrome-enforced extension origin via pinned `allowed_origins`, **navigation-level private-origin blocking only** — attach-time + `Page.frameNavigated` URL check (Layer 2 of §7.4) + driver-side `blockPrivateAddresses` before `Page.navigate` (Layer 3 of §7.4). **NOT covered in Phase 1**: subresource filtering (images/scripts/XHR initiated by page JavaScript can still reach internal hosts), DNS rebinding, arbitrary `fetch()`/WebSocket opened by page code. These are Phase 2 (Layer 1). Readers evaluating SSRF coverage: this is **not** a complete SSRF mitigation — treat Phase 1 as "agent actions cannot reach internal hosts, but page-initiated subresources can".
- MV3 service-worker keepalive (active NM port + `chrome.alarms`) so sessions survive idle periods.
- Chrome + Brave on macOS + Linux. Extension installed via "Load unpacked" from `~/.koi/browser-ext/extension/`.

**Non-goals (Phase 1 — moved to Phase 2)**
- Firefox / Safari.
- Windows (native-messaging paths stubbed but unimplemented).
- Edge, Arc, Chromium, Vivaldi, Opera — NM manifest paths coded in the browsers table for future use, not tested in Phase 1.
- **Layer 1 SSRF interception** (`Fetch.requestPaused` network-level blocking, DNS pinning, subresource filtering). Phase 1 has Layer 2 + Layer 3 only — covers navigation, not subresource fetches or DNS-rebinding. §7.4 is explicit about this reduced guarantee; must also be in `docs/L2/browser-ext.md` security section.
- Persistent audit trail (`~/.koi/browser-ext/audit.log` NDJSON). Phase 1 logs via the existing debug logger only (best-effort console.error, no rolling NDJSON).
- Broader real-Chromium automated E2E in default CI (full user-flow `launchPersistentContext` harness) is Phase 2. Phase 1 ships the **idle-resume test in the default CI gate** because MV3 keepalive correctness is ship-critical — any regression in Chrome's alarms/port semantics silently drops live sessions in production. Phase 2 expands to full-flow E2E tests beyond the idle-resume case.
- Fine-grained per-origin scopes (Phase 2 — uses `chrome.storage.sync`).
- `@koi/scopes` / ReBAC integration (Phase 2 hook).
- Sidecar Chrome launcher (dropped — doesn't deliver session inheritance).
- `rotate-token` command.
- `@koi/cli` subcommand proxy.
- Sidebar / tab-picker UI.

**Phase 2 (follow-up, separate issue)**
- Cross-platform (Windows + registry entries).
- Layer 1 SSRF interception (`Fetch.requestPaused` + DNS pinning + subresource filtering).
- Persistent audit trail (rolling NDJSON, 10 MB × 5).
- Tab-picker / sidebar UI + per-origin allowlist stored in `chrome.storage.sync`.
- Automated E2E via Playwright `launchPersistentContext` + loaded extension in default CI.
- Token rotation command (`rotate-token`).
- `@koi/cli` subcommand proxy.
- Remaining Chromium browsers (Edge, Arc, Chromium, Vivaldi, Opera) validated + in docs.

## 3. Architectural constraints (what ruled the design)

- **Cannot use `chrome.sockets` / `chrome.sockets.tcpServer`** — deprecated, Chrome-apps only, not available in MV3 extensions. Rules out the issue's proposed WebSocket-in-extension approach.
- **Cannot reach CDP on a running Chrome from an external process** without `--remote-debugging-port`. The only in-process bridge is `chrome.debugger` from an extension.
- **Chrome Native Messaging** is the architecturally clean solution: manifest-registered host, `allowed_origins` binds extension ID, no listening TCP ports. Pattern proven by Claude Code's `claudeInChrome` subsystem (2,089 LOC reference).

These constraints collapse the issue's "Phase 1 = native host only, Phase 2 = extension" decomposition. The extension is on the **critical path of Phase 1**; what varies across phases is breadth / polish, not core architecture.

## 4. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Koi agent process (bun)                                              │
│                                                                       │
│  @koi/tool-browser  ──(BrowserDriver)──►  @koi/browser-ext (L2)       │
│                                             │                         │
│                                             │ spawn subprocess        │
│                                             ▼                         │
│                               connects UNIX sock (0700/0600)          │
└─────────────────────────────────────────────┼─────────────────────────┘
                                              ▼
                                    ┌─────────────────────────────────┐
                                    │  Koi native host (Node.js, pinned│
                                    │  see §6.6 for runtime rationale) │
                                    │  @koi/browser-ext/native-host   │
                                    │   stdin/out ◄─NM frames──► ext  │
                                    │   WS (127.0.0.1:0) ◄ driver     │
                                    └──────────────┬──────────────────┘
                                                   │ native messaging
                                                   ▼
                                    ┌─────────────────────────────────┐
                                    │  MV3 extension service worker    │
                                    │  chrome.debugger.attach(tabId)  │
                                    │  chrome.debugger.sendCommand    │
                                    └──────────────┬──────────────────┘
                                                   │ CDP
                                                   ▼
                                    ┌─────────────────────────────────┐
                                    │  User's live Chrome tab          │
                                    └─────────────────────────────────┘
```

**Per tool call (e.g. `browser.click`)**

```
tool-browser.click(ref=e3)
  → browser-ext driver.click(ref=e3)
    → @koi/browser-playwright driver (port of v1)
      → playwright.connectOverCDP({ wsEndpoint: 127.0.0.1:<port> })
        → local WS server in native host
          → unix socket → native host core
            → stdout NM frame → Chrome → extension service worker
              → chrome.debugger.sendCommand(tabId, "Input.dispatchMouseEvent", …)
                → CDP response travels back through the same chain
```

The driver reuses **all** of browser-playwright's 20-method implementation, accessibility serializer, error translator, ref resolver. Only the CDP transport is new.

## 5. Package layout

### 5.1 New / ported packages

```
packages/lib/browser-a11y/              ← NEW L0u (extracted from v1 browser-playwright)
  src/
    a11y-serializer.ts                  ← DOM → compact text tree
    error-translator.ts                 ← Playwright error → KoiError
    ref-resolution.ts                   ← aria-ref + getByRole+nth strategies
    index.ts
  package.json  (deps: @koi/core)
  __tests__/

packages/drivers/browser-playwright/    ← PORT from archive/v1 (minimal v2 compliance pass)
  src/
    playwright-browser-driver.ts        ← existing, + wsEndpoint transport option
    browser-detection.ts                ← existing, unchanged
    cdp-transport.ts                    ← NEW: pluggable Playwright transport
    index.ts
  package.json  (deps: @koi/core, @koi/browser-a11y, playwright)

packages/drivers/browser-ext/           ← NEW L2
  src/
    driver.ts                           ← createExtensionBrowserDriver()
    unix-socket-transport.ts            ← CDP over unix socket
    native-host/
      host.ts                           ← stdin/stdout ↔ unix socket bridge
      message-reader.ts                 ← NM 4-byte LE framing
      install.ts                        ← NM manifest write per-browser
      browsers.ts                       ← Chromium browser config table
      cli.ts                            ← install/uninstall/status commands
    auth.ts                             ← install-time token
    index.ts
    bin/koi-browser-ext.ts              ← CLI entry (bunx @koi/browser-ext …)
  extension/                            ← MV3 source
    manifest.json
    service-worker.ts                   ← native port ↔ chrome.debugger bridge
    build.ts                            ← esbuild → dist/extension/
  package.json  (deps: @koi/core, @koi/browser-playwright, @koi/browser-a11y, zod)
  __tests__/
```

### 5.2 Layer compliance

- `browser-a11y` is **L0u**: pure functions over L0 types (`BrowserSnapshotResult`, `KoiError`). Imports from `@koi/core` only.
- `browser-playwright` (L2) imports: L0 + `browser-a11y` (L0u) + `playwright` (external).
- `browser-ext` (L2) imports: L0 + `browser-a11y` (L0u) + `browser-playwright` (peer L2) + `zod` (external).

The one L2-to-L2 edge (`browser-ext → browser-playwright`) is unavoidable: `browser-ext` is a transport-specialization of the same driver. Options considered:

- **A. Document waiver** — rejected; sets bad precedent.
- **B. Extract L0u `@koi/browser-a11y`** — **chosen**. Pure logic moves where it belongs; the remaining `browser-playwright` surface consumed by `browser-ext` is just `createPlaywrightBrowserDriver({ wsEndpoint, transport })`.

### 5.3 Public API

```typescript
// @koi/browser-ext
export interface HostSelector {
  readonly instanceId?: string;          // stable UUID — authoritative across SW restarts / host respawns
  readonly pid?: number;                 // exact host pid — authoritative within a lifetime
  readonly name?: string;                // advisory — user-configured label
  readonly browserHint?: string;         // advisory — UA brand hint, MAY fail to disambiguate
}

export type ReattachPolicy = "consent_required_if_missing" | "prompt_if_missing";

export function createExtensionBrowserDriver(options?: {
  readonly instancesDir?: string;       // default: ~/.koi/browser-ext/instances
  readonly authToken?: string;          // default: ~/.koi/browser-ext/token
  readonly select?: HostSelector;       // narrows when multiple hosts live; required if > 1
  readonly connectTimeoutMs?: number;   // default: 10_000 (wait for extension to spawn host)
  readonly pollIntervalMs?: number;     // default: 250 (instances-dir scan interval)
  // Controls what happens when auto-reconnect (§9.2) revisits a previously-attached
  // tab whose `allow_once` grant was lost with the service worker:
  //   - "consent_required_if_missing" (default) — do NOT prompt; surface
  //     REATTACH_REQUIRES_CONSENT. Safe for headless / unattended agents.
  //   - "prompt_if_missing" — trigger a fresh browser consent notification.
  //     Use when the agent session has a human in the loop who can approve.
  readonly reattachPolicy?: ReattachPolicy;
  // Runtime callback (optional). Invoked by the driver each time an attach is
  // about to be (re)issued after auto-reconnect, giving the caller a chance to
  // choose the reattach policy per-call based on UI context. Returns the
  // policy to use for that specific attach. Overrides `reattachPolicy` when set.
  readonly onReattach?: (context: { tabId: number; origin: string }) => ReattachPolicy;
}): BrowserDriver;

export function runBrowserInstall(opts: InstallOptions): Promise<Result<InstalledInfo, KoiError>>;
export function runBrowserUninstall(): Promise<Result<void, KoiError>>;
export function runBrowserStatus(): Promise<Result<StatusInfo, KoiError>>;
export function runNativeHost(): Promise<void>;   // --native-host entry
```

### 5.4 CLI surfaces

- **Phase 1**: `bunx @koi/browser-ext install | uninstall | status`. Standalone bin. No `@koi/cli` coupling.
- **Phase 2**: thin proxy subcommand in `@koi/cli` that delegates to the bin. Added once the package stabilizes.

## 6. Wire protocol

Three framed channels. Each has its own framing and schema.

### 6.1 Driver ↔ Native host (Unix socket / Windows named pipe)

Framing: 4-byte LE length prefix + JSON payload. Matches Claude Code's MCP-client socket convention.

```typescript
// Channel A: Driver ↔ Host. Everything on the unix-socket. The driver can
// originate only the `*_request`-shaped frames below; the host can originate
// the corresponding `*_ack` / `cdp_result` / `cdp_error` / `cdp_event` /
// `session_ended` frames. Host MUST reject any NM-only frame (see NmFrame
// below) arriving from a driver socket with an audit-log entry.
type DriverFrame =
  | {
      kind: "hello";
      token: string;                              // from ~/.koi/browser-ext/token (mode 0600)
      driverVersion: string;                      // semver of the @koi/browser-ext package the driver was built with
      // Protocol versions the driver supports. Host compares against its own
      // supported list; if the intersection is empty, host replies
      // `hello_ack { ok: false, reason: "version_mismatch" }` and closes.
      // Host picks the highest common version and pins it for the connection;
      // all subsequent frame shapes follow that protocol version.
      readonly supportedProtocols: readonly number[];
      // Connection-scoped lease token. 16-byte random, hex-encoded. Host pins
      // this value to the socket on successful hello and rejects any later
      // `attach` frame whose `leaseToken` differs. A single connection =
      // exactly one leaseToken for its lifetime.
      leaseToken: string;
      // Optional privileged admin bit. ONLY honored when `adminKey` matches
      // the contents of ~/.koi/browser-ext/admin.key (separate file, mode 0600,
      // written at install time — distinct from `token`). Admin-authenticated
      // connections are the ONLY ones that may trigger `admin_clear_grants` on
      // the NM channel. Non-admin connections asking for admin actions are
      // rejected at the host before any NM frame is emitted.
      readonly admin?: { readonly adminKey: string };
    }
  | { kind: "hello_ack"; ok: true; role: "driver" | "admin"; hostVersion: string; extensionVersion: string | null; wsEndpoint: string; selectedProtocol: number }
  | { kind: "hello_ack"; ok: false; reason: "bad_token" | "bad_admin_key" | "lease_collision" | "bad_lease_token" | "extension_not_connected" | "version_mismatch"; hostSupportedProtocols?: readonly number[] }
  | { kind: "list_tabs" }
  | { kind: "tabs"; tabs: readonly { id: number; url: string; title: string }[] }
  | { kind: "attach"; tabId: number; leaseToken: string; attachRequestId: string; reattach?: false | "consent_required_if_missing" | "prompt_if_missing" }
  | { kind: "attach_ack"; ok: true; tabId: number; leaseToken: string; attachRequestId: string; sessionId: string }
  | { kind: "attach_ack"; ok: false; tabId: number; leaseToken: string; attachRequestId: string; reason: "no_permission" | "tab_closed" | "user_denied" | "private_origin" | "timeout" | "already_attached" | "consent_required"; currentOwner?: { clientId: string; since: string } }
  | { kind: "detach"; sessionId: string }
  | { kind: "detach_ack"; sessionId: string; ok: boolean; reason?: "not_attached" | "chrome_error" | "timeout" }
  | { kind: "cdp"; sessionId: string; method: string; params: unknown; id: number }
  | { kind: "cdp_result"; sessionId: string; id: number; result: unknown }
  | { kind: "cdp_error"; sessionId: string; id: number; error: { code: number; message: string } }
  | { kind: "cdp_event"; sessionId: string; eventId: string; method: string; params: unknown }
  //
  // Host → driver (originate-only from host). The debugger session for
  // `sessionId` has ended for a reason not initiated by this driver (e.g.
  // user navigated the tab, tab closed, DevTools opened, extension reload,
  // private-origin enforcement). Driver flushes the session locally and
  // surfaces this to the agent via error-translator → PERMISSION/STALE_REF.
  // This replaces the stale Koi.privateOriginDetached custom event path.
  //
  | { kind: "session_ended"; sessionId: string; tabId: number; reason: "navigated_away" | "private_origin" | "tab_closed" | "devtools_opened" | "extension_reload" | "unknown" }
  | { kind: "bye" };

// Channel B: Host ↔ Extension. Chrome native-messaging pipe only. Drivers
// cannot originate these frames; the host validates any inbound driver frame
// against `DriverFrame` and rejects anything in `NmFrame` that arrives on a
// driver socket. See §6.2 for the strict directional validation table.
type NmFrame =
  | { kind: "list_tabs" }
  | { kind: "tabs"; tabs: readonly { id: number; url: string; title: string }[] }
  | { kind: "attach"; tabId: number; leaseToken: string; attachRequestId: string; reattach?: false | "consent_required_if_missing" | "prompt_if_missing" }
  | { kind: "attach_ack"; ok: true; tabId: number; leaseToken: string; attachRequestId: string; sessionId: string }
  | { kind: "attach_ack"; ok: false; tabId: number; leaseToken: string; attachRequestId: string; reason: "no_permission" | "tab_closed" | "user_denied" | "private_origin" | "timeout" | "already_attached" | "consent_required"; currentOwner?: { clientId: string; since: string } }
  //
  // Host → extension: detach a tab's debugger session (issued on driver
  // `detach` or on owning-driver disconnect cleanup per §8.5). Extension
  // calls chrome.debugger.detach and replies with `detach_ack`.
  //
  | { kind: "detach"; sessionId: string; tabId: number }
  | { kind: "detach_ack"; sessionId: string; tabId: number; ok: boolean; reason?: "not_attached" | "chrome_error" | "timeout" }
  | { kind: "cdp"; sessionId: string; method: string; params: unknown; id: number }
  | { kind: "cdp_result"; sessionId: string; id: number; result: unknown }
  | { kind: "cdp_error"; sessionId: string; id: number; error: { code: number; message: string } }
  | { kind: "cdp_event"; sessionId: string; eventId: string; method: string; params: unknown }
  //
  // Host → extension: the driver owning `leaseToken` has disconnected.
  // Extension cancels any pending_consent/attaching state involving this
  // leaseToken per §8.5 cleanup. ONLY valid on the NM channel.
  //
  | { kind: "abandon_attach"; leaseToken: string }
  | { kind: "abandon_attach_ack"; leaseToken: string; affectedTabs: readonly number[] }
  //
  // Host → extension: administrative frame for uninstall / revocation. Clears
  // persistent grants from chrome.storage.local. Extension MUST also detach
  // every currently-attached tab whose origin was covered by a cleared grant.
  // Only valid after a host-internal authentication gate (see §8.7) — hosts
  // do NOT forward this frame from any driver input.
  //
  | { kind: "admin_clear_grants"; scope: "all" | { origins: readonly string[] } }
  | { kind: "admin_clear_grants_ack"; clearedOrigins: readonly string[]; detachedTabs: readonly number[] }
  //
  // Host → extension at boot (see §8.5 boot-time probe): request the extension
  // to enumerate every tabId where Chrome currently has an attached debugger
  // session not owned by the extension's in-memory state. Used for crash-safe
  // recovery after a prior host died before writing journal quarantine and/or
  // the extension's port.onDisconnect failed. Extension MUST force-detach any
  // tab it still claims to own locally but which Chrome disputes, then return
  // the full list.
  //
  | { kind: "attach_state_probe"; requestId: string }
  | { kind: "attach_state_probe_ack"; requestId: string; attachedTabs: readonly number[] }
  //
  // Extension → host: the debugger session for `tabId` has ended outside of
  // an explicit `detach` from the owning driver. Host MUST clear its `tabId`
  // ownership entry and emit a `session_ended` frame on the owning driver's
  // channel. ONLY valid on the NM channel.
  //
  | { kind: "detached"; sessionId: string; tabId: number; reason: "navigated_away" | "private_origin" | "tab_closed" | "devtools_opened" | "extension_reload" | "unknown"; priorDetachSuccess?: boolean }
  //
  // Chunked envelope — used for BOTH results and events when payload > threshold.
  // All chunks in a group share: sessionId, correlationId, payloadKind. Reassemble when
  // `index + 1 === total`. The reassembled base64-decoded UTF-8 JSON represents exactly
  // the shape specified by `payloadKind`:
  //   payloadKind = "result_value" → JSON is the `result` field of a cdp_result frame.
  //   payloadKind = "event_frame"  → JSON is an entire serialized cdp_event frame.
  // The discriminator is NOT derived from the `correlationId` prefix — it is explicit on
  // every chunk. `correlationId` remains a routing key only.
  //
  | {
      kind: "chunk";
      sessionId: string;
      correlationId: string;                // "r:${id}" for results, "e:${uuid}" for events
      payloadKind: "result_value" | "event_frame";
      index: number;
      total: number;
      data: string;                          // base64 of a UTF-8 JSON slice
    };
```

**Channel-direction matrix (hard enforcement at the host):**

| Frame kind | Driver → Host (unix sock) | Host → Driver (unix sock) | Host → Ext (NM) | Ext → Host (NM) |
|------------|---------------------------|---------------------------|-----------------|-----------------|
| `hello` / `hello_ack` | yes / yes | yes / yes | — | — |
| `list_tabs` / `tabs` | yes / no | no / yes | yes / no | no / yes |
| `attach` / `attach_ack` | yes / no | no / yes | yes / no | no / yes |
| `detach` | yes (DriverFrame: `{sessionId}`) | no | yes (NmFrame: `{sessionId, tabId}`) | no |
| `cdp` | yes | no | yes | no |
| `cdp_result` / `cdp_error` / `cdp_event` | no | yes | no | yes |
| `chunk` | no | yes | no | yes |
| `session_ended` | no | yes | — | — |
| `abandon_attach` / `abandon_attach_ack` | — | — | yes / no | no / yes |
| `admin_clear_grants` / `admin_clear_grants_ack` | — | — | yes / no | no / yes |
| `attach_state_probe` / `attach_state_probe_ack` | — | — | yes / no | no / yes |
| `detached` | — | — | no | yes |
| `detach_ack` | no | yes | no | yes |
| `bye` | yes | no | — | — |

Host validates every inbound frame against the kind-column for its channel. Out-of-channel frames are rejected with an audit entry; the offending side's connection is closed on the second offense within a session. This is the cross-client trust boundary: one authenticated driver cannot spoof NM-only frames (`abandon_attach`, `detached`) to cancel or detach another driver's work.

- First frame from driver **must** be `hello`. Host rejects any other frame pre-auth.
- **End-to-end protocol version negotiation** (single version across driver, host, extension):
  - Host startup: on spawn, host reads `extension_hello.supportedProtocols` (the extension declares its own supported set — see §6.5). Host computes `extensionLegIntersection = extension.supportedProtocols ∩ HOST_SUPPORTED_PROTOCOLS` and replies `host_hello { selectedProtocol: max(extensionLegIntersection) }` (or closes the NM port with protocol-mismatch if empty). This pins the host↔extension version for the lifetime of this host process.
  - Driver `hello` arrives later (drivers connect after the NM leg is already negotiated). Host computes `driverLegIntersection = driver.supportedProtocols ∩ { hostSelectedProtocolOnExtensionLeg }` — the driver leg MUST choose the **same** protocol already pinned with the extension. If the driver doesn't advertise that specific version → reply `hello_ack { ok: false, reason: "version_mismatch", hostSupportedProtocols: [hostSelectedProtocolOnExtensionLeg] }` and close. Drivers see which single version the active host↔extension pair has picked and can either reconnect after upgrading or surface a clear error.
  - This enforces a **single end-to-end protocol version** across all three parties. There is no translation layer; skewed driver/extension versions cannot both succeed at once. A dual-stack (v1+v2) host connected to a v1-only extension locks down to v1 for the NM leg; any v2-only driver that later connects fails at the driver leg with `version_mismatch`. Mixed-version rollouts either succeed uniformly or fail closed at handshake.
- **Why this catches the `reattach` enum change**: in protocol v1, `attach.reattach` is the enum defined in §6.1. A driver built against a hypothetical v0 advertising `supportedProtocols: [0]` against a v1 host↔extension pair is rejected at the driver `hello` before any `attach` can be sent. A v0/v1 dual-support driver advertises `[0, 1]`; if the host has already selected v1 with the extension, the driver leg also pins v1 and the driver speaks the enum `reattach` shape.
- `hello_ack` also carries `wsEndpoint` (local 127.0.0.1:<random-port>) that Playwright's `connectOverCDP()` connects to. WS handshake requires `Authorization: Bearer <token>` header.

### 6.2 Native host ↔ Extension (Chrome Native Messaging)

- Framing: Chrome-mandated 4-byte LE length prefix + JSON (1 MB max per Chrome spec).
- Schema: `NmFrame` as defined in §6.1 — **not** identical to `DriverFrame`. NM-only frames (`abandon_attach`, `abandon_attach_ack`, `detached`) are explicitly absent from `DriverFrame`; driver-only frames (`hello`, `hello_ack`, `bye`, `session_ended`) are explicitly absent from `NmFrame`. The host bridges frames it is allowed to forward (per the matrix in §6.1) and synthesizes the channel-appropriate frame shape — most notably, an extension-originated `detached` (NM) triggers a host-emitted `session_ended` (driver channel) after the lease-map update. The host is **not** a dumb relay; it performs schema validation and state-machine side effects for the frames that cross channels.

### 6.3 Extension ↔ Chrome CDP

- `chrome.debugger.attach({ tabId }, "1.3")`.
- `chrome.debugger.sendCommand(target, method, params)` for each `cdp` frame.
- `chrome.debugger.onEvent` → forwarded as `cdp_event` frames.

**`sessionId` uniqueness invariant (protocol requirement)**

- Every successful `chrome.debugger.attach` MUST produce a fresh `sessionId` that has never been used in this host's lifetime and never will be reused again by this host. The value is a **canonical UUID v4** generated via `crypto.randomUUID()` at the moment the extension observes a successful attach. The wire schema types `sessionId: string`, but this normative rule narrows the allowed shape.
- `sessionId` is **generated by the extension**, not by Chrome's debugger API or the host. It is bound 1:1 to a specific `chrome.debugger` session. A tab that detaches and re-attaches gets a **new** `sessionId`; a tab attached by a different client gets a **new** `sessionId`; a host restart starts with an empty `sessionId` space, and the extension generates fresh UUIDs on the next attach.
- Host and extension validate format at the channel boundary — any frame referencing a non-UUID `sessionId` is rejected as a protocol violation (audit + close connection on repeat).
- All stale-frame/drop logic across the spec (chunk reassembly keyed by `(sessionId, correlationId)` in §6.4, outstanding-detach `Map<sessionId, ...>` in §8.5, `detached` tuple validation in §8.5, `session_ended` routing in §6.1) relies on this uniqueness. An implementation that reuses `sessionId` across reconnects can alias retired sessions onto live ones and corrupt ownership — that would be a direct protocol violation, not a grey area.
- The extension persists a small "recently retired sessionIds" set (bounded, last 1024 entries) across SW-restart in `chrome.storage.session`-backed memory only for debug/audit; this set is advisory (used to surface warnings when a validation failure would drop a frame with a just-retired ID), never authoritative. On SW death the set is lost; uniqueness within the next extension instance is still guaranteed by UUID v4 randomness.

### 6.4 Correlation / ordering / backpressure / chunking

- Each `cdp` frame carries monotonic `id`; driver matches `cdp_result` / `cdp_error` by id. Out-of-order allowed.
- Extension silently drops frames for unknown `sessionId`; driver errors on orphan `cdp_result`.
- **1 MB per-frame cap is Chrome-mandated on the NM channel.** Payloads exceeding ~900 KB (conservative buffer below the 1 MB limit for JSON overhead) are chunked using the `chunk` envelope defined in §6.1:
  - The reassembly key is the **tuple `(sessionId, correlationId)`** — CDP `id` is unique only within a session, and two attached tabs can emit matching `id`s concurrently.
  - `correlationId` format:
    - Results: `"r:${id}"` (where `id` is the CDP call id, unique within a session).
    - Events: `"e:${crypto.randomUUID()}"` — generated at send time. Events have no natural id, and multiple large events of the same method can be in flight concurrently.
  - `correlationId` is a routing key only; senders and receivers MUST NOT infer payload semantics from its prefix. The wire-level discriminator is `payloadKind` on every chunk frame — both are required to agree across the chunk group or the receiver drops the group.
  - Sender emits **only `chunk` frames** for oversized payloads (no partial `cdp_result`/`cdp_event` placeholder): N frames, each ≤700 KB base64 `data`, sharing `sessionId` + `correlationId` + `payloadKind`, sequential `index` 0..N-1, same `total`. All chunks in a group MUST have identical `payloadKind`.
  - Receiver buffers in `Map<\`${sessionId}|${correlationId}\`, chunk[]>`; when a chunk arrives with `index === total - 1`, concatenates all `data` buffers in `index` order, base64-decodes, parses as UTF-8 JSON, then:
    - `payloadKind === "result_value"` → synthesize `{ kind: "cdp_result", sessionId, id: parseInt(correlationId.slice(2)), result: <parsed> }`.
    - `payloadKind === "event_frame"` → parsed JSON IS a complete `cdp_event` frame; receiver validates its shape and dispatches it directly.
    - Mismatched `payloadKind` across chunks with the same correlation key → entire group dropped, audit log entry, `TRANSPORT_LOST` if caller is awaiting.
  - Receiver drops partial chunks after 30s idle → surfaces `TRANSPORT_LOST` for the awaiting caller (result correlations); silently discards event correlations (events are advisory, no awaiter).
  - Concurrent oversized results across sessions are unambiguous because the tuple key includes `sessionId`. A test case (`chunking.test.ts`) exercises two sessions both returning `id=7` screenshots concurrently and asserts each session receives its own payload. Another test case sends chunks with inconsistent `payloadKind` → asserts group drop + `TRANSPORT_LOST`.
- **Operations that routinely exceed 1 MB**: `Page.captureScreenshot` (easily 2–10 MB for `fullPage: true`), `Page.getResourceContent` for large JS bundles, `Runtime.evaluate` returning large strings, `Page.captureSnapshot` (MHTML). All must work through chunking — this is non-negotiable because `@koi/tool-browser` exposes `browser_screenshot` and we claim BrowserDriver-surface compatibility.
- No explicit backpressure beyond OS socket buffering. If a driver blocks reading, Bun's socket write back-pressures onto the native host, which back-pressures onto Chrome's NM port (Chrome buffers ~64 MB before dropping). Sufficient for our payload classes.

### 6.5 Control frames (watchdog + protocol metadata)

These are protocol-level frames not part of `DriverFrame`'s data path. They travel only between host and extension over NM (never between driver and host):

```typescript
type NmControlFrame =
  | { kind: "ping"; seq: number }
  | { kind: "pong"; seq: number }
  | {
      kind: "extension_hello";
      extensionVersion: string;
      supportedProtocols: readonly number[];
      // Host identity info — populated by the extension at connect time.
      // `instanceId` is THE stable identity: a UUID generated on first extension
      // install and persisted in chrome.storage.local at `koi.instanceId`. It
      // survives SW restarts, extension reloads (but NOT uninstall/reinstall).
      // `browserSessionId` is a SEPARATE UUID regenerated on every browser
      // launch: persisted in chrome.storage.session (cleared when the browser
      // process exits). A changed `browserSessionId` signals a browser
      // restart — Chrome-side debugger state is gone, so the host MUST discard
      // all quarantine entries for this instanceId (see §8.5 quarantine rules).
      // Grouping and supersede are keyed on `instanceId` alone — `name` and
      // `browserHint` are advisory labels only, never used as a uniqueness key.
      identity: {
        readonly instanceId: string;          // UUID v4 — survives browser restart
        readonly browserSessionId: string;    // UUID v4 — regenerated on browser launch
        readonly browserHint: string;         // advisory: "Google Chrome", "Brave", "" if unknown
        readonly name: string;                // advisory: user-configurable label
      };
      // Restart-stable ordering pair. `epoch` is persisted across service-worker
      // restarts in chrome.storage.local and strictly increases. `seq` increments
      // per connectNative call within one service-worker lifetime (resets on SW restart).
      readonly epoch: number;
      readonly seq: number;
    }
  | {
      kind: "host_hello";
      hostVersion: string;
      selectedProtocol: number;
      // Current install identity. 32-byte random, hex-encoded, regenerated on
      // every `bunx @koi/browser-ext install` run and persisted at
      // ~/.koi/browser-ext/installId (mode 0600). Extension compares against
      // the installId it has stored in chrome.storage.local; on mismatch,
      // extension MUST wipe every persisted grant (both `always` and
      // `privateOriginAllowlist`) before accepting any attach. See §8.7 for
      // the reinstall-revocation mechanism.
      installId: string;
    };
```

- `extension_hello` is emitted once on NM port connection by the extension. Host replies with `host_hello` carrying the negotiated protocol version. Mismatch → host closes NM port; driver surfaces `EXT_WRONG_VERSION`.
- `ping`/`pong` are bidirectional keep-alive. Host sends `ping` every 5s after `host_hello`; extension replies `pong` within 2s. Three consecutive misses → host closes NM port, exits; driver reconnect cycle triggers.
- §6.2's statement that "host is a dumb bridge after auth" applies only to `DriverFrame` traffic. Control frames are terminated at the host and never forwarded to the driver.

### 6.6 Host runtime: Node.js (pinned for Phase 1)

Native host executable is Node.js, not Bun. Rationale:

- NM framing (4-byte LE length + JSON) over `process.stdin`/`process.stdout` is proven on Node.js (Claude Code's 2,089-LOC reference runs on Node).
- Bun's stdin buffering semantics under Chrome's NM pipe have not been validated; a framing regression would manifest as total session loss with no graceful degradation.
- Bun-as-host is a Phase 2 investigation: gated behind acceptance tests exercising NM roundtrip across mac/linux with payloads near the 1 MB cap, zero-length, and chunked writes from Chrome.
- Rest of `@koi/browser-ext` (driver, CLI, tests) runs on Bun normally. Only the host subprocess spawned via `node <path>/native-host.js` uses Node. Node version pinned: ≥ 20.11 (LTS).
- **Install-time prerequisite**: `bunx @koi/browser-ext install` resolves `which node` to an **absolute path**, runs `"${absPath}" --version`, parses the semver, requires ≥ 20.11. If absent or older, install **fails hard** with guidance to install Node; no Bun fallback in Phase 1.
- The **absolute node binary path** resolved at install time is **baked into the wrapper script** (not re-resolved at runtime). Example wrapper content:
  ```sh
  #!/bin/sh
  # Auto-generated by @koi/browser-ext install. Do not edit.
  exec "/opt/homebrew/bin/node" "/Users/you/.koi/browser-ext/native-host.js" "$@"
  ```
  Rationale: Chrome launches native hosts with a stripped PATH (especially on macOS — launched by `launchd`'s user agent, which has a minimal PATH lacking `/opt/homebrew/bin` and `$HOME/.nvm`). `/usr/bin/env node` would resolve to a different binary (or nothing) than `which node` did in the user's interactive shell. Baking the absolute path guarantees the validated binary is the one Chrome executes.
- If the user updates Node (e.g., `nvm install 22`), they re-run `bunx @koi/browser-ext install` to regenerate the wrapper with the new absolute path. `status` command warns if the baked path no longer exists.
- Wrapper is installed at `~/.koi/browser-ext/bin/native-host`, mode `0o755`.

### 6.7 Playwright transport integration

Playwright's `chromium.connectOverCDP({ wsEndpoint })` consumes a loopback WebSocket. The native host binds `127.0.0.1:0` (kernel-assigned port) and bridges WS frames to the unix socket / NM pipe. Chosen over patching Playwright internals (`ConnectionTransport`) — trades one extra hop for zero coupling to Playwright's private API.

## 7. Security model

### 7.1 Trust boundaries + mechanisms

| Boundary | Mechanism |
|---|---|
| Extension ↔ Native host | NM manifest `allowed_origins` pins extension ID(s) chosen for the current build. Chrome enforces: **only a matching-ID extension can spawn our host.** Two separate key regimes avoid a committed-key escalation path: (1) **Dev regime** — `extension/keys/dev.pem` committed to the repo, produces a well-known dev extension ID; dev host manifest **only** lists this dev ID in `allowed_origins`, and `install.ts` runs in `--dev` mode only when invoked with the `KOI_DEV=1` env var (or `--dev` CLI flag). (2) **Production regime** — a separate private key held out-of-tree (CI secret / release manager's keychain), never committed; produces a distinct production extension ID hardcoded into `install.ts` when built with `--release`. Release builds only list the production ID in `allowed_origins`. Because the production key is not in the repo, a checkout cannot produce a release-matching extension, so anyone copying the source still cannot spawn the release host from their own extension. Dev host will reject a production-ID connection and vice versa. Phase 1 is **dev-only** for the release artifact — production key generation and first production release are tracked as Phase 2 release work. For Phase 1 the binding is "anyone who can read the repo can run a dev host against a dev extension on their own machine," which is acceptable because the dev host writes manifests only under `$HOME` and controls only the user's own browser. |
| Driver ↔ Native host | Unix socket dir `0o700`, socket file `0o600` (OS uid isolation). `hello` token validated byte-for-byte. |
| Driver ↔ Host local WS | Bound `127.0.0.1:0`. `Authorization: Bearer <token>` required on upgrade. 403 otherwise. |

### 7.2 Tokens (driver + admin)

Two independent 32-byte random secrets, both generated at `koi browser install`, both stored under `~/.koi/browser-ext/` with mode `0o600`:

| File | Holder | Purpose |
|------|--------|---------|
| `token` | any local caller running as the same user | Driver-role `hello.token`. Required for normal attach / CDP operations. |
| `admin.key` | CLI only (`bunx @koi/browser-ext uninstall` / future admin commands) | `hello.admin.adminKey`. Elevates the connection to `role: "admin"` and unlocks the `admin_clear_grants` NM path. |

- The split means a stolen `token` cannot be used to clear persistent grants; revocation requires `admin.key`, which is only read by the official CLI path. Both files are `0o600` in `$HOME` — same trust level as an SSH key; defense is uid-based OS isolation, not cryptographic separation.
- Neither is rotated in Phase 1. `rotate-token` / `rotate-admin-key` commands are Phase 2.
- Negative test (§10.5 security table): a normal `hello` without `admin` block that attempts any admin-gated operation is rejected at the host with `PERMISSION`; the NM channel does not emit the admin frame. Captured in `auth.test.ts` + `admin-gate.integration.test.ts`.

### 7.3 Per-tab consent (overview)

Two distinct grant classes: **`allow_once`** (ephemeral, session-only, invalidated on navigation) and **`always`** (persistent per-origin, persists across browser restarts). Full state machine in §8.6. Phase 2 adds sidebar panel + in-browser revoke UI + tab picker.

### 7.4 SSRF / private-origin guarding

Defense-in-depth defined at three layers. **Phase 1 ships Layer 2 + Layer 3 only**; Layer 1 is Phase 2. A live browser can still navigate or hit DNS that resolves to internal IPs at runtime — Layer 2 catches every navigation, but subresource fetches initiated by page JavaScript pass through until Layer 1 lands.

**Layer 1 — Extension-side network interception (PHASE 2 — not in Phase 1)**

- Planned: extension enables `Fetch.enable` on attach; every request (navigations, subresources, XHR, fetch, WebSocket) surfaces as `Fetch.requestPaused`. Block by host + resolved IP; DNS-pin per origin against rebinding; allowlist via extension UI.
- Phase 1 users are warned in `docs/L2/browser-ext.md` that subresource filtering is not implemented yet.

**Layer 2 — Attach-time + navigation URL check (PHASE 1)**

- On every `chrome.debugger.attach` (initial and reattach after navigation), extension reads `tab.url`. If origin matches the blocklist (`localhost`, `*.local`, `*.internal`, `*.corp`, `*.home.arpa`, plus RFC1918/RFC4193/loopback/link-local IP literals: `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`, `fe80::/10`), responds `attach_ack { ok: false, reason: "private_origin" }` unless the user has explicitly allowlisted the origin via the extension options page.
- Enforced on every subsequent `Page.frameNavigated` event for the attached tab. If the tab navigates to a blocked origin, the extension immediately calls `chrome.debugger.detach` and sends a **`detached { sessionId, tabId, reason: "private_origin" }`** NM frame (the canonical extension-initiated detach path — see §6.1 `NmFrame` and §8.5 extension-detach reconciliation). The host translates that into a **`session_ended { sessionId, tabId, reason: "private_origin" }`** frame on the owning driver's channel, which the driver's `error-translator` maps to `PERMISSION`. There is no `Koi.*` `cdp_event` path for this — prior drafts that mentioned `Koi.privateOriginDetached` are superseded.

**Layer 3 — Driver-side defensive check (PHASE 1)**

- Existing `blockPrivateAddresses` check in `@koi/browser-playwright` applies before any `Page.navigate` CDP command is sent. Defense-in-depth against a compromised extension or stale policy state.

**What Phase 1 actually guarantees**

- Agent cannot navigate to a private origin — Layer 2 + Layer 3 both block.
- Agent cannot attach to a tab already at a private origin — Layer 2 blocks.
- Agent cannot navigate mid-session to a private origin — Layer 2 blocks + detaches.
- **Known gap**: a public page that fetches a subresource from an internal host (e.g. `https://example.com` embedding `https://internal.corp/script.js`) — subresource is NOT blocked in Phase 1. The agent's snapshot will contain the public page; its own actions cannot trigger the subresource directly, but page-initiated fetches execute. Phase 2 closes this via Layer 1.
- Chrome's own `chrome://` URLs → not attachable (Chrome policy; not our concern).

### 7.5 Revocation

- Disable extension → Chrome tears down NM port → host exits → driver observes socket close.
- Delete `~/.koi/browser-ext/token` → next session re-prompts install.
- `koi browser uninstall` → removes NM manifest from each browser dir + token + socket dir + (Phase 2) Windows registry.

### 7.6 Audit trail (Phase 1 — minimal)

- Phase 1 uses the existing debug logger (`console.error` with a `[koi:browser-ext]` prefix). Enabled via `KOI_DEBUG=browser-ext`. No on-disk rolling NDJSON in Phase 1.
- Phase 2 adds persistent audit: rolling NDJSON at `~/.koi/browser-ext/audit.log`, 10 MB × 5 files. Captures timestamp, `tab.origin` (not full URL), CDP method, `agentId`. Excludes page content, cookies, form values, screenshots.

### 7.7 Explicit out-of-scope (Phase 1)

- No mTLS (uid+mode enough).
- No encrypted at-rest token (0600 in $HOME = same trust level as SSH key).
- No forward secrecy (CDP unencrypted by Chrome design).
- No ReBAC / `@koi/scopes` integration (Phase 2 hook).

## 8. Setup flow

### 8.1 Install

```
$ bunx @koi/browser-ext install
  Checking prerequisites...
    Node.js ≥ 20.11 (required for native host runtime)  ✓ v20.12.1
  Detecting Chromium browsers... ✓ Google Chrome, ✓ Brave
  Writing native messaging host manifest:
    ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.koi.browser_ext.json  ✓
    ~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/…            ✓
  Writing host wrapper: ~/.koi/browser-ext/bin/native-host (0755)                               ✓
  Generating auth token... ✓ (~/.koi/browser-ext/token, mode 0600)
  Unpacking extension bundle → ~/.koi/browser-ext/extension/                                    ✓

  Next step:
    1. Open chrome://extensions
    2. Enable Developer mode
    3. Load unpacked → ~/.koi/browser-ext/extension/
    4. Run `bunx @koi/browser-ext status` to verify
```

**Idempotency**: re-running `install` is safe. It re-unpacks the extension bundle (overwrites `~/.koi/browser-ext/extension/`, preserving auth token and user settings in `chrome.storage.local`), rewrites NM manifests only if content changed, and never rotates the token unless `--rotate-token` is passed. Users hit by `EXT_WRONG_VERSION` can re-run `install` then click the reload icon in `chrome://extensions`.

**Node prerequisite failure**:

```
$ bunx @koi/browser-ext install
  Checking prerequisites...
    Node.js ≥ 20.11 (required for native host runtime)  ✗ not found

  Install Node.js ≥ 20.11 before continuing:
    macOS (Homebrew):  brew install node
    macOS (official):  https://nodejs.org/en/download
    Linux (nvm):       nvm install 20

  Phase 1 does not support a Bun fallback. See spec §6.6.
```

### 8.2 Runtime attach

```
 chrome        extension (MV3 SW)     host (Node)        driver (Bun)
   │    load + boot  │                   │                    │
   │────────────────►│                   │                    │
   │                 │ connectNative ────►│ (Chrome execs     │
   │                 │                   │   wrapper script)  │
   │                 │                   │ bind unix sock     │
   │                 │                   │ atomic-write       │
   │                 │                   │ ~/.koi/…/instances/│
   │                 │                   │   <hostPid>.json   │
   │                 │◄── extension_hello│                    │
   │                 │ host_hello ──────►│                    │
   │                                                          │
   │                                                          │ createExt…Driver()
   │                                                          │ scan instances/*.json
   │                                                          │ liveness check (pid, sock)
   │                                                          │◄── socket path
   │                                     │ connect ◄──────────│
   │                                     │ hello(token) ◄─────│
   │                                     │ hello_ack(ok, wsEndpoint) ──►
   │                                                          │
   │                 │◄── list_tabs ──── host ◄────────────── │
   │  chrome.tabs.query ◄────│                                │
   │                 │ ── tabs ─────────►│ ──────────────────►│
   │                                                          │
   │                 │◄── attach(tabId=42) ── host ◄──────────│
   │ chrome.debugger.attach ◄──│ (first-time user consent)    │
   │                 │ ── attach_ack(ok,sessionId) ──────────►│
   │                                                          │
   │ === Playwright connectOverCDP({wsEndpoint}) drives normally ===
```

### 8.3 Host lifecycle — single spawn authority

**Phase 1 is extension-spawned only.** The driver **never** spawns the native host. Rationale: Chrome's Native Messaging protocol requires extension-initiated spawn (`chrome.runtime.connectNative("com.koi.browser_ext")` is what causes Chrome to exec the manifest's `path` and bind stdin/stdout). A driver-spawned standalone host is a different OS process from the Chrome-spawned NM host — if both exist, they are two independent processes competing for the same socket path, with Chrome's NM pipe bound only to one of them. That is split-brain. We avoid it by mandating a single spawn authority.

**Lifecycle**

1. User loads the extension in Chrome (and/or Brave, Edge, etc.). Each browser's extension service worker boots independently.
2. Each service worker calls `chrome.runtime.connectNative("com.koi.browser_ext")`. Chrome/Brave reads its own NM manifest, execs the wrapper script, binds that host's stdin/stdout.
3. Each host boots, waits for `extension_hello`, then:
   a. Binds its own Unix socket at `$XDG_RUNTIME_DIR/koi-browser-ext/<pid>.sock` (dir `0o700`, file `0o600`) and calls `listen()`.
   b. Starts accepting connections.
   c. Exchanges `extension_hello`/`host_hello` — validates protocol version, completes negotiation.
   d. **Only after (a)+(b)+(c) all succeed**, writes a **per-host discovery file** at `~/.koi/browser-ext/instances/<hostPid>.json` with shape:
      ```json
      {
        "schemaVersion": 1,
        "pid": 12345,
        "socket": "/run/user/1000/koi-browser-ext/12345.sock",
        "ready": true,
        "instanceId": "9d1a5c4e-3b7f-4f8a-8c2d-1a2b3c4d5e6f",  // STABLE identity — grouping key
        "name": "personal",                                     // advisory label
        "browserHint": "Google Chrome",                         // advisory label
        "extensionVersion": "0.1.0",
        "epoch": 12,
        "seq": 3,
        "startedAt": "2026-04-18T12:34:56.789Z"
      }
      ```
   The file is the **readiness signal**. Its presence guarantees the socket is already accepting connections and the extension has completed its hello exchange.
4. Driver `createExtensionBrowserDriver({ select?: HostSelector })` discovers by scanning `~/.koi/browser-ext/instances/*.json`:
   - Each file is liveness-checked: parse, check `ready === true`, `process.kill(pid, 0)` (POSIX) or OS-specific existence check (Windows: `OpenProcess` via FFI — in Phase 1 falls through to Phase 2 since Windows is out of scope), `fs.statSync(socket)` confirms the socket node exists.
   - Dead files (dead pid or missing socket) are unlinked on-sight.
   - Default selection: if exactly one live host → use it. If multiple → error `HOST_AMBIGUOUS { alternatives: [...] }` listing `{pid, name, browserHint, extensionVersion}` and telling the caller to pass `select`.
   - `HostSelector` narrows the match; must resolve to exactly one live host. **`pid` is authoritative**; `name` is authoritative if unique; `browserHint` is best-effort and may fail to disambiguate (two Chrome profiles both report `"Google Chrome"` — in that case the error lists candidates and asks for `pid` or `name`).
5. Driver connects → `hello(token)` → `hello_ack` → ready.
   - Even though step 3d guarantees the socket was accepting connections when the discovery file was written, a host can die between file-write and driver-connect. Driver treats `ECONNREFUSED`, `ENOENT`, or `hello` handshake failure as "file was stale" → unlinks the file → re-scans → retries until `connectTimeoutMs` (default 10s) elapses.
6. If no live host is found after `connectTimeoutMs`, driver returns `HOST_SPAWN_FAILED { reason: "no_extension_running" }`: "Make sure Chrome (or your chosen browser) is open and the Koi Browser Extension is enabled."

**Crash / reconnect — single-flight guarantee with restart-stable identity**

One extension instance ↔ at most one live NM host at a time. Both the disconnect handler AND the `chrome.alarms` keepalive can observe a dropped port and want to reconnect — we must not race them into two concurrent `connectNative` calls. We must also correctly order hosts when the service worker dies and respawns with fresh in-memory state.

**Restart-stable host identity (`epoch` + `seq`)**

- `epoch`: persisted in `chrome.storage.local` at key `koi.hostEpoch`, initialized to `Date.now()` on first install. On every service-worker boot, the extension reads `epoch`, increments `seq` reset to 0, and writes back `epoch` **only** if it was missing (never overwrites the install-time epoch). Instead, on every SW boot the extension writes a new `bootId = Date.now()` to `storage.local` and uses `(bootId, seq)` as the ordering key.
  - Actually: simpler scheme. Persist a **monotonic 64-bit counter** at `koi.hostBootCounter` in `chrome.storage.local`. On every SW boot, atomic read-modify-write (`chrome.storage.local` writes are atomic): `hostBootCounter = hostBootCounter + 1`. Use that as the extension-side `epoch`. In-memory `seq` increments per `connectNative` within this SW lifetime. The pair `(epoch, seq)` is the ordering key — strictly monotonic across SW restarts because `epoch` is persisted.
- Discovery file carries both: `"epoch": 12, "seq": 3`. Driver comparison: host A supersedes host B iff `(A.epoch > B.epoch)` OR `(A.epoch === B.epoch && A.seq > B.seq)`.

Extension state (in-memory per SW lifetime):
```typescript
type ConnState =
  | { kind: "idle" }
  | { kind: "connecting"; epoch: number; seq: number; startedAt: number }
  | { kind: "connected";  epoch: number; seq: number; port: chrome.runtime.Port };
let state: ConnState = { kind: "idle" };
let seq = 0;          // resets on SW restart
let epoch = -1;       // loaded from chrome.storage.local on boot; see below
```

Lifecycle rules:
- SW boot: `chrome.storage.local.get("koi.hostBootCounter")` → `epoch = (stored ?? 0) + 1` → `chrome.storage.local.set({ "koi.hostBootCounter": epoch })` **atomically** before any `ensureConnected` call.
- `ensureConnected()`:
  1. If `epoch < 0` → await the boot write above.
  2. If `state.kind === "connecting"` → no-op.
  3. If `state.kind === "connected"` and port alive → no-op.
  4. Else → `seq++`; set `state = { kind: "connecting", epoch, seq, startedAt: Date.now() }`; call `chrome.runtime.connectNative`. On connect, send `extension_hello` carrying `{ epoch, seq }`. On success, `state = { kind: "connected", epoch, seq, port }`. On failure, `state = { kind: "idle" }` and re-schedule after backoff.
- Disconnect handler: `port.onDisconnect.addListener(() => { state = { kind: "idle" }; setTimeout(ensureConnected, 1000); })`.
- Alarm handler: fires every ~24s; calls `ensureConnected()` — single-flight guarantees no duplicate spawn.
- Stale-(epoch,seq) rule at host: if the host receives an `extension_hello` with `(epoch, seq)` lower than or equal to a previously seen pair from the same browser instance (tracked by host-side rolling record in the discovery dir), host refuses the handshake and exits.

**Host-side — strict boot sequence (single readiness signal)**

The host MUST complete ALL of the following in order before any externally observable readiness is published. At no point in this sequence is the `instances/<pid>.json` discovery file created; the file's existence IS the readiness signal.

1. Read `installId` from `~/.koi/browser-ext/installId`.
2. Bind the Unix socket (per §8.3 step 3a) — listening but not yet accepting driver connections (driver connections on the socket are held in the OS kernel's accept queue until the host's `accept()` loop starts, step 8 below).
3. Wait for `extension_hello` on stdin. Validate `epoch >= 1, seq >= 1, installId format, instanceId format`.
4. Send `host_hello { installId, selectedProtocol, ... }`. Extension-side installId revocation wipe runs here (§8.7) before extension marks the port ready.
5. Read the persisted quarantine journal for this `instanceId` (§8.5), compare `browserSessionId` for validity, seed `hostOwnershipMap` with every quarantined `tabId` as `detaching_failed`.
6. Issue `attach_state_probe { requestId }` on the NM channel. Await `attach_state_probe_ack`. For every `tabId` in the ack not already in the quarantine map, add a fresh `detaching_failed` entry with `sessionId: "orphan"` and persist it to the journal under the lock.
7. If the ack reported any tabs that the extension itself then force-detached, issue a second `attach_state_probe` at t+2s; await; reconcile the quarantine map (tabs reported as NOT attached the second time can have their `sessionId: "orphan"` entries cleared).
8. **Start the socket `accept()` loop FIRST** (so the host is genuinely connectable — a driver that races in at this moment gets immediate `accept()` handling, not `ECONNREFUSED`).
9. **Only after accept() is running**: atomically write the discovery file `instances/<pid>.json` with `ready: true`, `epoch`, `seq`, and all quarantine state already seeded. The file's existence is the readiness signal, and at this point the socket is guaranteed connectable.
10. Supersede + GC rule runs immediately after the discovery file is written: new host scans `instances/` for files with (a) the **same `instanceId`** AND (b) a strictly-lower `(epoch, seq)` pair. For each such file, it verifies the pid is **dead** (`process.kill(pid, 0)` fails) before unlinking it. Never unlinks a file whose process is still alive.

**Driver-side stale-file GC** (companion rule — hardens against the accept-race that R10 flagged):
- When a driver discovers an instance file and its `connect()` fails with `ECONNREFUSED` or `ENOENT`, the driver does NOT immediately unlink the file.
- Instead, it retries `connect()` up to 3 times with 100ms/300ms/1s backoff. If all retries fail, it then re-checks the file's `pid` via `process.kill(pid, 0)`. The file is unlinked ONLY if BOTH (a) all connect retries failed AND (b) the pid is dead. If the pid is alive but connections keep refusing, the driver returns `HOST_SPAWN_FAILED { reason: "connect_refused_live_pid" }` without unlinking — the file is preserved for a newer driver attempt or for the host to self-correct.
- This prevents a driver racing into the narrow window between `accept()` loop start (step 8 above) and discovery file publication (step 9) from ever destroying a live host's registration. Under the normal host boot sequence this window is zero-length (step 8 runs strictly before step 9 in the same host process), so the hardening is defense-in-depth against implementation-time mistakes or OS scheduling surprises.

**Driver-visible contract**:
- Until step 8 completes, there is NO `instances/<pid>.json` for this new host, so no driver can discover it. A driver in its auto-reconnect loop (§9.2) polling the instances directory simply doesn't find a live host and retries until it appears.
- Drivers that connected to the OLD host's socket before it died continue to see their sockets in TCP FIN/CLOSE state and retry against a freshly published instance file — which does not appear until probe + quarantine seeding is done.
- There is no window in which a host is visible to drivers before all stale-session fencing is complete. This is the single readiness contract.
- Earlier phrasing in prior drafts (discovery file written at §8.3 step 3d, before probe) is superseded — §8.3 step 3d should be read as "only after the full boot sequence in §8.5 is complete".

**Regression test** `boot-sequence-no-early-ready.integration.test.ts` (default CI): kill a host that had tab 42 attached (extension's port.onDisconnect handler throws before detaching tab 42, so Chrome retains the stale attach). Start a new host. Assert:
- No `instances/<pid>.json` file is visible on disk until the new host has completed `attach_state_probe` and seeded quarantine for tab 42.
- A driver calling `createExtensionBrowserDriver({ pollIntervalMs: 50 })` during this window sees `HOST_SPAWN_FAILED { reason: "no_extension_running" }` repeatedly until probe completes.
- After probe completes and `instances/<pid>.json` appears with quarantine for tab 42, driver connects and sees `already_attached` for tab 42 — NOT a successful attach that would then be torn down by a compensating detach.

**Driver discovery**

- Driver scans `instances/*.json`. Groups files by `instanceId`. Within each group, picks the file with highest `(epoch, seq)` where the pid is still alive; lower-ranked live files in the same group are ignored (not unlinked — transient stragglers that will exit on their own or be cleaned up by the next new host per the supersede rule).
- After per-group selection, if **more than one group** has a live pick, the result is `HOST_AMBIGUOUS` with `alternatives` listing each group's pick as `{ instanceId, pid, name, browserHint, extensionVersion }`. The driver caller must supply a `select` narrowing. `select.instanceId` is the canonical authoritative selector; `select.name` / `select.browserHint` are advisory matchers that can still produce `HOST_AMBIGUOUS` if multiple groups match the advisory label.
- If the highest-ranked file's socket connect fails with `ECONNREFUSED` / `ENOENT`, driver retries against the next-highest until timeout.

**Socket + discovery flow under crash**

- Host dies → NM port drops → extension `onDisconnect` → `ensureConnected` after 1s → new host (new pid, seq+1, same epoch) → new socket → new `instances/<newPid>.json`.
- Service worker dies and respawns → epoch increments via the persisted counter → any surviving old-epoch host is ranked below the new host → driver selects the newest `(epoch, seq)` → old host eventually times out or exits cleanly when the SW-respawn-triggered `ensureConnected` makes Chrome drop its NM pipe.

**Discovery ownership (no shared-file contention)**

- Each host owns its own `instances/<hostPid>.json` file. Writes are atomic via `tmp file + rename`.
- Host removes **only its own** file on clean shutdown: `unlink(~/.koi/browser-ext/instances/<myPid>.json)`. Hosts never touch files belonging to other pids.
- Stale files (dead pid) are garbage-collected lazily by any scanner — driver removes files whose pid is dead or whose socket is missing.
- Two hosts starting concurrently write two separate files. Two hosts exiting concurrently each delete only their own file. No shared-writer race.

**Explicit non-goal**: no "daemon mode" host that runs independent of Chrome. If Chrome isn't running, that browser's host isn't running. Multiple browsers = multiple independent host processes.

### 8.4 MV3 service-worker lifetime

Chrome MV3 evicts an extension service worker after ~30s of no events. If the service worker dies, its `chrome.debugger` sessions go with it and `chrome.runtime.connectNative` ports close — tearing down every attached tab. We must actively keep the worker alive for the duration of an agent session.

**Two stacked keepalives (both required):**

**Primary — active native-messaging port**

- An active `chrome.runtime.connectNative` port keeps the service worker alive (Chrome 110+ documented behavior: "ports to native messaging hosts count as extension activity that resets the idle timer").
- The host sends `ping` control frames every 5s (§6.5). Each inbound NM message resets the worker's idle timer. The worker replies with `pong`, which is another event — bidirectional keepalive.

**Secondary — `chrome.alarms` fallback**

- Extension installs `chrome.alarms.create("koi-keepalive", { periodInMinutes: 0.5 })` on startup. Chrome enforces a 0.5-minute minimum for repeating alarms on normal installs, so this is the lowest cadence available. It fires at the 30s eviction boundary — the primary NM-port keepalive (which fires every 5s via `ping`/`pong`) is the workhorse that actually prevents eviction; the alarm is a belt-and-suspenders backup that will re-wake the worker if it was evicted just before the alarm fires.
- `chrome.alarms.onAlarm` fires a callback that touches `chrome.storage.session` — forces Chrome to restart the worker if it died despite the port keepalive.
- If the alarm fires and the NM port is disconnected, the callback re-invokes `chrome.runtime.connectNative` to re-establish the bridge.

**Why both**: Chrome's worker-lifetime rules have changed several times across minor versions (the "5-minute max even with active port" cap was removed in 110, re-debated in 116). Stacking means a regression in either path leaves the other as backup.

**Visibility when user switches tabs / minimizes window**

- Chrome suspends background activity for inactive windows aggressively. `chrome.debugger` sessions are per-tab, not per-window; they continue receiving CDP events even when the tab is in a background window. Worker keepalive described above is independent of tab focus.

**Normative: extension cleanup on NM port disconnect**

- The service worker MUST install a handler on the NM port's `onDisconnect` event. The handler processes each `TabAttachState` phase distinctly:
  1. **`attached` tabs**: call `chrome.debugger.detach({ tabId })`, awaiting the promise; tolerate the `Debugger is not attached` error (idempotent success).
  2. **`attaching` tabs** (in-flight `chrome.debugger.attach` promise): **do NOT clear the state yet, and BLOCK any new attach on the same tab until cleanup settles**. `chrome.debugger.detach` is tab-scoped, not sessionId-scoped — Chrome does not let us target a specific stale session by ID. Therefore any new `chrome.debugger.attach` call on the same tab while an old in-flight attach's cleanup is pending would risk the compensating detach tearing down the new session by tabId. The extension handles this with a per-tab `cleanup_pending` quarantine state:
     - On `port.onDisconnect`, each `attaching` entry transitions to an extension-side `cleanup_pending { tabId, attachPromise }` record.
     - The `attachPromise` is chained with a continuation:
       - On late success → `chrome.debugger.detach({ tabId })` (compensating detach). Log "compensating detach after host loss". Then remove `cleanup_pending[tabId]`.
       - On late failure → remove `cleanup_pending[tabId]` (no debugger session was ever created).
     - All pending `participants` on the old `attaching` tab are failed with `attach_ack { ok: false, reason: "user_denied", ... }` + log "requester dropped: host lost".
     - **While `cleanup_pending[tabId]` exists**, any new `attach { tabId }` frame (from the new host after reconnect) is held in a per-tab waiter queue on the extension side and not forwarded to `chrome.debugger.attach`. Once `cleanup_pending[tabId]` is cleared (late continuation finished), the queued new attach runs normally.
     - **Waiter queue release — single-gate rule**: the per-tab waiter queue is released **only** when the original `chrome.debugger.attach` promise reaches a terminal state (settled success with compensating detach done, or settled failure). Time-based release is explicitly forbidden because `chrome.debugger.detach` is tab-scoped, not session-scoped — releasing the queue before the old promise dies would let a new owner attach, and a later compensating detach would tear down that new session.
     - **10s pathological-path observability**: if `cleanup_pending[tabId]` persists for more than 10s, the extension **does NOT release the queue**. Instead it issues an advisory force-detach (`chrome.debugger.detach({tabId})`) AS A BEST-EFFORT poke of Chrome to nudge the hung debugger state, but the `cleanup_pending` entry STAYS (the original attach promise is still outstanding). Extension emits a host-ward observability frame (a `cdp_event`-shaped frame for diagnostics — not a state-mutation frame) so the host can log "cleanup_pending exceeded 10s for tab X" for post-mortem. **If the original promise ultimately never settles**, the tab is permanently fenced in `cleanup_pending` for this SW lifetime; queued attaches fail with `tab_closed` reason after a per-attach timeout (60s). The tab becomes usable again only when the SW restarts, at which point `cleanup_pending` is lost with SW memory and Chrome's stale debugger state will surface via the boot-time probe defined below in the §8.4 host boot flow (finding 2's fix).
     - **Integration test** `cleanup-pending-timeout.integration.test.ts` (default CI): mock the original `chrome.debugger.attach` promise to never settle. Fire host loss. Assert: `cleanup_pending[tabId]` persists. At t=10s the advisory force-detach fires but the entry stays. Per-queued-attach timeout of 60s causes any racing new attach to fail with `tab_closed`. SW restart (simulated) clears cleanup_pending from memory; on the new SW boot, the host's boot-time probe (see Finding 2 fix below) detects stale Chrome debugger state if any and fences via quarantine.
     - **Late-success case** (original attach promise settles AFTER host loss, BEFORE SW restart): the chained continuation fires its compensating `chrome.debugger.detach({tabId})`. Because the waiter queue was never released during the `cleanup_pending` window, no new owner was admitted — the forced detach only tears down the stale session. After the continuation completes, `cleanup_pending[tabId]` is removed and the waiter queue is released; any queued new attach proceeds against a definitively unattached tab.
     - **Late-failure case** (original attach promise rejects): no compensating detach needed. `cleanup_pending[tabId]` is removed; waiter queue released.
     - Host-side impact: after a host crash+reconnect, attach requests on a tab whose previous `attaching` state hasn't settled are delayed until that settlement (typically <1s; up to 60s in the pathological case before the attach times out). Driver's perspective: slower attach on the exact window of crash+reconnect for a tab that was mid-attach. Correct behavior — ownership hasn't handed off yet.
  3. **`pending_consent` tabs**: dismiss any open browser notification; fail all `participants` with `user_denied`; clear the state. No in-flight attach to track.
  4. After processing all tabs, call `ensureConnected()` after a 1s backoff to re-spawn a host via `chrome.runtime.connectNative` (§8.3 single-flight guard applies). Note: the compensating-detach continuations from step 2 may run concurrently with or after the new host boot; this is safe because the detach targets the specific old sessionId, independent of any new session on the same tab.
- This handler is the authoritative release mechanism for host-loss (see `detaching_failed` recovery in §8.5). Implementers MUST NOT assume Chrome auto-releases `chrome.debugger` sessions when the native host dies — that assumption is wrong; only service-worker termination does that.
- **Integration test** `host-kill-during-attach.integration.test.ts` (default CI): driver issues `attach(tabId=42)` which reaches the extension's `attaching` phase. Before `chrome.debugger.attach` resolves, test harness SIGKILLs the host. Assert: (a) `port.onDisconnect` runs; (b) the `attaching` tab is retained with its continuation bound; (c) when Chrome's debugger.attach resolves later, a compensating `chrome.debugger.detach` fires; (d) a subsequent attach (via new host) to tab 42 succeeds without `Debugger is already attached`.

**Idle-resume test — Phase 1 observability**

`idle-resume.integration.test.ts` — launches real Chromium with the extension loaded via `launchPersistentContext`. After `attach`, harness does nothing for **90 seconds** (3× the 30s eviction window). Asserts:
- Service worker is still alive (verified via `chrome.management.getSelf` health probe).
- NM port has not dropped — detected via in-memory counters exposed by the test harness over the driver's normal `DriverFrame` channel (no persistent log read — persistent audit is Phase 2).
- Driver-side session is still valid: `browser.snapshot()` succeeds without a preceding re-attach or re-snapshot cycle.
- `pong` count observed by the host equals `ping` count sent, for the full 90s window — both are tracked in the host's in-memory state and reported via a test-only `DriverFrame` extension (`{ kind: "debug_stats" }`, gated behind `KOI_TEST=1` env var so it cannot be triggered in production).

**Execution gate**: this test is in the **default Phase 1 CI gate**. MV3 keepalive is the production-critical path that prevents silent session loss on idle; Chrome's alarm/port semantics have changed across minor versions, so a regression-detecting test against real Chromium is mandatory before release. Run via `bun run test --filter=@koi/browser-ext`. Budget: ~95s per CI invocation (90s idle + setup/teardown) — acceptable for the single-test slowdown.

**Supplemental fast test** for protocol correctness: `control-frames.integration.test.ts` (mocked extension, no real Chromium) runs a 30-second mock-idle interval and exercises the same `ping`/`pong` accounting via the in-memory counter path. This catches protocol-level regressions in seconds; the real-Chromium idle-resume test catches browser-level regressions.

### 8.5 Tab-attach lease (single-owner semantics)

`chrome.debugger.attach` is effectively exclusive per tab: Chrome will reject a second attach while one is active, and even if we tunneled both requests through the extension, the underlying CDP session is per-debugger-client. Two drivers connecting to the same host and both attempting `attach(tabId=42)` must not silently clobber each other.

**Lease mechanism**

- Driver generates a `leaseToken` (16-byte random, hex-encoded) and sends it in the `hello` frame. Host validates format (32 hex chars) and **pins** it to the socket for the connection's lifetime. A subsequent `attach` carrying a different `leaseToken` → host replies with a protocol-violation `attach_ack { ok: false, reason: "no_permission", ... }` and closes the socket after an audit log entry. Collision check: if another live connection has already pinned the same `leaseToken` (extraordinarily unlikely at 16 bytes, but cheap to check), host rejects the new `hello` with `hello_ack { ok: false, reason: "lease_collision" }`.
- The host-tracked identity `clientId` is the pinned `leaseToken` of the originating socket.

**Host ownership map — per-request granularity**

Two separate structures, each keyed differently. Neither collapses multiple in-flight requests onto one slot.

```typescript
// Per-tab ownership — at most one COMMITTED owner or detaching_failed per tab.
// attachRequestId recorded only for tracing/debug; ownership identity is the
// clientId (leaseToken), not the request that produced it.
type TabOwnership =
  | { phase: "committed";        clientId: string; sessionId: string; committingRequestId: string; since: number }
  | { phase: "detaching_failed"; clientId: string; sessionId: string; reason: "chrome_error" | "timeout"; since: number };

const ownership: Map<number /*tabId*/, TabOwnership> = new Map();

// Per-request in-flight attach state — one entry PER `attach` frame received.
// Keyed by the COMPOSITE `(clientId, attachRequestId)` so two drivers that
// happen to generate the same UUID cannot overwrite each other. Multiple
// concurrent requests for the same (tabId, clientId) each have their own entry.
type InFlightKey = `${string /*clientId*/}:${string /*attachRequestId*/}`;

type InFlightAttach = {
  tabId: number;
  clientId: string;           // the connection's pinned leaseToken
  attachRequestId: string;
  receivedAt: number;
  abandoned: boolean;         // set true if the driver socket closes first
};

const inFlight: Map<InFlightKey, InFlightAttach> = new Map();

function inFlightKey(clientId: string, attachRequestId: string): InFlightKey {
  return `${clientId}:${attachRequestId}` as InFlightKey;
}
```

**Rules**

1. **On receiving `attach { tabId, leaseToken, attachRequestId }` from a driver**:
   - Host validates `leaseToken === socket.pinnedLeaseToken`. Mismatch → protocol violation (§8.5).
   - Collision check: if `inFlight.has(inFlightKey(leaseToken, attachRequestId))` with the same `tabId` → idempotent replay, respond to the duplicate by simply waiting for the existing entry's outcome (no new entry created). If the same key exists with a **different** `tabId`, reject the new frame as a protocol violation (`attach_ack { ok: false, reason: "no_permission" }` + audit) — attachRequestId reuse across tabs on the same socket is undefined.
   - Cross-socket duplicate check: if any `inFlight` entry exists with the **same `attachRequestId` but a different `clientId`** (two different drivers picked the same UUID), **do not overwrite**. The composite key prevents collision by construction; two drivers therefore coexist. (The check runs only on the composite key; accidental UUID clashes across clients are harmless because the keys are distinct.)
   - If `ownership[tabId]` is `detaching_failed` → reply `attach_ack { ok: false, reason: "already_attached" }` (with `currentOwner` field omitted — the spec's optional field is legitimately absent when no live owner exists) immediately; do not forward to extension; do not create an `inFlight` entry.
   - If `ownership[tabId]` is `committed` with `clientId !== leaseToken` → reply `attach_ack { ok: false, reason: "already_attached", currentOwner }` immediately; do not forward.
   - If `ownership[tabId]` is `committed` with `clientId === leaseToken` → reply immediately with the existing `sessionId` (idempotent); do not forward.
   - **Pending-window cross-client check**: if any `inFlight` entry exists for this `tabId` with a **different `clientId`** than the incoming `leaseToken` (a first client's attach is still awaiting `attach_ack`), reply `attach_ack { ok: false, reason: "already_attached" }` immediately (no `currentOwner` yet — ownership hasn't committed). Do not forward. **Only the first client's attach ever reaches the extension's participants/waiter machinery; §8.6 queuing applies only to multiple concurrent requests from the same `clientId`.**
   - Otherwise (no `inFlight` entry for this tab, OR same-`clientId` `inFlight` entry exists) → `inFlight.set(inFlightKey(leaseToken, attachRequestId), { tabId, clientId: leaseToken, attachRequestId, receivedAt: now, abandoned: false })` and forward the frame to the extension. Same-client second-attach-while-pending is allowed — extension appends it to `participants` per §8.6.

2. **On receiving `attach_ack { ok: true, tabId, leaseToken, attachRequestId, sessionId }` from the extension**:
   - Look up `inFlight.get(inFlightKey(leaseToken, attachRequestId))`.
   - If absent → log + drop (stale ack; request may have been abandoned and removed, or the ack's `(leaseToken, attachRequestId)` is forged).
   - **Tuple validation**: compare the ack's `tabId` against the stored `InFlightAttach.tabId`. If they differ → reject the ack as a protocol error, log it, and issue a compensating `detach { sessionId, tabId: ack.tabId }` on NM (tear down the stray debugger session the extension just created). Do **not** commit ownership. Remove the stored `InFlightAttach` as a normal removal.
   - If tuple matches and `abandoned === false`:
     - If `ownership[tabId]` is already `committed` with the same `clientId` by a different `attachRequestId` (a concurrent winning request from the same client already committed):
       - **sessionId-match check**: `ack.sessionId` MUST equal `ownership[tabId].sessionId`. In a correct extension implementation same-client parallel attaches collapse onto the single live CDP session, so the ack's `sessionId` is the one we already committed. If they **differ** → protocol error (a stray extension-side `chrome.debugger.attach` produced a second CDP session). Reject the ack: do NOT forward to the driver, issue a compensating `detach { sessionId: ack.sessionId, tabId }` to retire the stray session, remove the `inFlight` entry, and log an audit entry. (Drivers whose attach promise is still outstanding will time out via the normal CDP-command timeout budget; they can retry with a fresh `attachRequestId` and will see the committed session or `detaching_failed` deterministically.)
       - If they match → forward the ack as-is (idempotent success). Ownership identity remains one `clientId` with one `sessionId`.
     - If `ownership[tabId]` is `committed` with a **different** `clientId` than the ack's `leaseToken` → this should not be reachable (rule 1 would have short-circuited), but defensively: reject the ack as a protocol error, issue compensating `detach`, do NOT commit.
     - Else → set `ownership[tabId] = { phase: "committed", clientId: leaseToken, sessionId, committingRequestId: attachRequestId, since: now }` and forward the ack.
   - If tuple matches and `abandoned === true` → the driver disconnected before the ack arrived. Do NOT commit ownership. Issue an NM `detach { sessionId, tabId }` and handle its `detach_ack` per §8.5 detach rules (`ok=true` → clear transient state; `ok=false`/timeout → install `detaching_failed` on `ownership[tabId]`). Remove from `inFlight`.

3. **On receiving `attach_ack { ok: false, ..., tabId, leaseToken, attachRequestId }` from the extension**:
   - Look up `inFlight.get(inFlightKey(leaseToken, attachRequestId))`. Tuple-validate `tabId` against the stored entry; on mismatch, reject as protocol error + log. On match, remove the entry and forward the ack to the driver (if its connection is still alive).
4. **On driver socket close** (disconnect):
   - Iterate all `inFlight` entries where `clientId === disconnected.leaseToken` (walk keys with that prefix). Set each `abandoned = true` so rule 2 above will detach any late-arriving success. Also send one `abandon_attach { leaseToken }` NM frame (coalesced — single frame covers all entries for this leaseToken; the extension prunes its own `participants` entries).
   - For every `ownership[tabId]` where `phase === "committed"` and `clientId === disconnected.leaseToken` → issue `detach { sessionId, tabId }` on NM and resolve per §8.5 (commit → clear on success, or `detaching_failed` on failure).

**Invariant**: ownership cardinality is still one committed owner per tab. Multiple concurrent `attach` requests from the same driver survive as independent `inFlight` entries; the first to succeed commits ownership; later successes (if any) are already-consistent because they share the same `clientId`. Different-client concurrent attaches never both reach the extension — the second is rejected at rule 1 before forward.
- Flow:
  - Tab not attached → host calls `chrome.debugger.attach`, records ownership keyed by `tabId` with the requesting `leaseToken`'s `clientId`, responds `attach_ack { ok: true, sessionId, leaseToken }`.
  - Tab attached by the same `clientId` → host responds with the existing `sessionId` + `leaseToken` (idempotent reattach — safe for driver-side retries).
  - Tab attached by a different `clientId` → host responds `attach_ack { ok: false, reason: "already_attached", currentOwner: { clientId, since } }`. Driver surfaces `PERMISSION { code: "TAB_BUSY" }`. Caller's options: wait, pick a different tab, or (future Phase 2) request a takeover.
- `detach` frames from a non-owner are rejected with a log entry and no state change.
- **Owner disconnect → clean detach of every owned tab.** When a driver disconnects (socket close or `bye` frame), host iterates the driver's owned tabs and for each one:
  1. Sends an NM `detach { sessionId, tabId }` frame to the extension (per the `NmFrame` schema in §6.1; host looks up `tabId` from its own ownership map).
  2. Extension calls `chrome.debugger.detach({ tabId })`. Tolerates the `"Debugger is not attached"` error (idempotent) — treats that as success.
  3. Extension replies with an NM `detach_ack { sessionId, tabId, ok: true }` on success, or `detach_ack { sessionId, tabId, ok: false, reason: "chrome_error" }` on unexpected Chrome error, or `detach_ack { sessionId, tabId, ok: false, reason: "not_attached" }` if Chrome reports the tab was never attached (idempotent success equivalent — treat as `ok: true`).
  4. Host waits for the `detach_ack` with a 5-second timeout.
     - **On `ok: true` or `not_attached`** → remove the tab from the ownership map. Any in-flight ops on that `sessionId` fail with `cdp_error { code: -32000, message: "Session detached: bye" }` which the driver translates to `STALE_REF`.
     - **On `ok: false` (reason: `chrome_error`) or 5s timeout** → do **not** clear ownership. Transition the entry to a terminal **host-side** `detaching_failed` state:
       ```
       hostOwnershipMap[tabId] = { phase: "detaching_failed", sessionId, reason, since }
       ```
       This is a **host-only** state. The extension-side `TabAttachState` for this tab may be anything from `idle` onward — the extension has already run `chrome.debugger.detach` (successfully or not) and is not expected to model the failed-detach window. Any `attach(tabId)` frame that reaches the host while this host-side state is set receives `attach_ack { ok: false, reason: "already_attached" }` (with `currentOwner` field omitted per the schema's optional semantics) before the host even forwards the frame to the extension. The extension never sees these rejected attaches and has no `detaching_failed` branch in §8.6.
       **The release mechanism is extension-side, not Chrome-side.** When the native host dies, the extension's NM `port.onDisconnect` fires. The extension handler is required to iterate every tab it currently holds a `chrome.debugger.attach` session on (tracked in SW memory) and call `chrome.debugger.detach({ tabId })` for each one, tolerating the `Debugger is not attached` error. This explicit extension-side detach is the authoritative release path for host loss — Chrome does **not** auto-release debugger sessions when the native-messaging host dies (only service-worker termination does that, and the MV3 keepalive in §8.4 is specifically designed to prevent SW termination during a session). The extension's own detach loop on `port.onDisconnect` is what clears Chrome's attachment state.
       **Per-instance durable quarantine journal.** Quarantine persistence is keyed on `instanceId` (from `extension_hello.identity.instanceId` — see §6.5), using one file per instance under a dedicated directory:
       ```
       ~/.koi/browser-ext/quarantine/
         <instanceId-1>.json   (mode 0o600)
         <instanceId-2>.json
         …
       ```
       Each file holds only entries for that `instanceId`, scoped to a single browser session, with per-entry owner attribution. A file-level `browserSessionId` field records which Chrome process the entries belong to; entries are discarded when a new browser session is observed (browser restart fully tears down Chrome-side debugger state, so any quarantine is stale). Each quarantine entry also carries its own writer stamp, so merge semantics work correctly across overlapping hosts:
       ```json
       {
         "schemaVersion": 2,
         "instanceId": "9d1a5c4e-3b7f-4f8a-8c2d-1a2b3c4d5e6f",
         "browserSessionId": "7a3f92b1-1f4c-4e8d-92a6-5c9b8d7e6f1a",
         "quarantined": [
           {
             "tabId": 42,
             "sessionId": "…",
             "reason": "chrome_error",
             "since": "2026-04-18T12:34:56.789Z",
             "writerEpoch": 12,
             "writerSeq": 3
           }
         ]
       }
       ```
       **Browser-session invalidation**: on host boot, after receiving `extension_hello`, the host reads `<instanceId>.json`. If the file's `browserSessionId` differs from the current `extension_hello.identity.browserSessionId`, the host discards every quarantined entry (browser restarted → Chrome has no attached debugger sessions → `tabId` values no longer identify the same tabs). The host then writes an empty quarantine file stamped with the new `browserSessionId` (or deletes the old file). This makes the `tabId` key restart-safe: stale quarantine can never block a fresh browser session's tabs.
       **Concurrency model: read-merge-write under lock**. Hosts with the same `instanceId` can transiently coexist during SW respawn overlap (per §8.3: the old host exits only after the new host's NM port takes over, and during that window either host may be first to observe a detach failure or clearance). Every rewrite is a **merge**, not an overwrite, gated by an advisory lock (POSIX `flock`/`LOCK_EX` on a sibling `<instanceId>.lock`; Windows Phase 2 uses `LockFileEx`).
       
       **Write procedure** (every host, every update):
       
       1. Acquire the `<instanceId>.lock` exclusive lock.
       2. Read the current file (if any).
       3. Compute the merge of on-disk entries and in-memory quarantine state, keyed by `tabId`:
          - For each `tabId` appearing in EITHER set, apply these rules:
            - If present in memory only → include my in-memory entry with my `(writerEpoch, writerSeq)`.
            - If present on disk only → include the on-disk entry verbatim (preserves the other host's record).
            - If present in both with the **same `sessionId`** → keep the entry with the higher `(writerEpoch, writerSeq)` (newer record wins for mutations like `since`; but the entry itself is preserved).
            - If present in both with **different `sessionId`s** → keep the entry with the higher `(writerEpoch, writerSeq)`; log the conflict. (Same tab quarantined under two different sessions across owner handoff is unusual but valid — the newer owner's observation wins.)
          - **Clearance rule**: a clearance is represented by the writer omitting the tab from its own in-memory quarantine state. To actually remove a disk entry, the writer must be the entry's own owner (matching `(writerEpoch, writerSeq)`) OR hold a strictly-newer `(writerEpoch, writerSeq)` pair. A stale writer (older `(epoch, seq)`) cannot clear a newer writer's entry; its merge leaves that entry in place.
       4. Write the merged result to `<instanceId>.json.tmp`, `fsync`, rename to `<instanceId>.json`.
       5. Release the lock.
       
       **Implications**:
       - Old host enters `detaching_failed` for tab X during overlap, new host has already written the file → old host reads, finds no entry for X on disk, merges its own X entry in, writes. Entry persists.
       - New host processes a clearance for tab Y it owns (seeded from file on boot) → merges, removing Y from its own set; since the new host's `(writerEpoch, writerSeq)` dominates all on-disk entries for Y, the entry is removed. Clearance succeeds.
       - Old host's in-memory set no longer contains tab Z (cleared via valid `detached { priorDetachSuccess: true }` before overlap began) → during the overlap, the old host rewrites and would want to remove Z, but Z on disk has been updated by the new host with a higher writer tuple (new host re-learned it at boot from the same source). The clearance rule prevents the old host from removing it. The new host will clear it when its own clearance arrives, preserving correctness.
       - File with empty `quarantined[]` → host deletes the file under lock.
       
       **Lifecycle**:
       - **On entering `detaching_failed` for a tab** → host immediately updates its instance file (atomic write) to add the entry. The entry is durable before the 30s self-kill timer is even armed.
       - **On self-kill** → host does NOT delete the instance file; the entries are still quarantined.
       - **On new host boot** (post-reconnect, same `instanceId`) → host reads `<instanceId>.json` (if present) and seeds `detaching_failed` for every listed `tabId`. The file is **NOT deleted** — it remains the authoritative record. Ownership map is seeded before the host binds its socket.
       - **On per-tab clearance** (via one of the two conditions below) → host updates the instance file (atomic rewrite) removing that tab's entry. When the file's `quarantined` array becomes empty, host deletes the file.
       - **On host crash** before clearance completes → the file still holds every unclear entry; the next host boot re-seeds quarantine from it.
       
       **Per-tab quarantine clearance** — unchanged conditions:
       - Extension `detached { sessionId, tabId, priorDetachSuccess: true }` NM frame whose `sessionId` matches the stored entry.
       - Per-tab CDP probe (`Target.getTargets` after handshake) reports no attached debugger session for the tab.
       
       **Multi-instance safety**: because the file name embeds `instanceId`, a separate browser profile's host cannot accidentally overwrite or delete this profile's quarantine. Each instance's recovery state is isolated. Dead-file GC (for instances whose extensions have been uninstalled) is out of scope for Phase 1; the directory grows at a bounded rate (one file per ever-installed extension instance), which is acceptable.
       
       Therefore the exit from `detaching_failed` is: (1) host force-exits on 30s timer after having already durably recorded the quarantine to its instance file, (2) Chrome's NM port drops, (3) extension `port.onDisconnect` handler detaches every previously-attached tab and marks future `detached` frames with `priorDetachSuccess: true` for tabs where the detach returned `ok: true` or `not_attached`, (4) extension calls `ensureConnected()`, (5) new host reads its instance file, seeds quarantine, binds socket, writes `instances/<pid>.json`, (6) driver's auto-reconnect re-reads the instances dir and picks up the new host. Previously-quarantined tabs remain `detaching_failed` until a valid clearance arrives.

       **Boot-time attach-state probe — crash-safe recovery** (addresses the case where the dying host SIGKILLed before writing quarantine entries, OR where the extension's `port.onDisconnect` handler itself failed mid-detach, leaving Chrome with stale debugger attachments that have no journal record):
       
       - On every new host boot, immediately after the `extension_hello`/`host_hello` handshake completes and BEFORE the host opens its socket to drivers, the host sends a special NM request `attach_state_probe { requestId }` to the extension. This is a new NM frame (§6.1 addition below).
       - Extension responds with `attach_state_probe_ack { requestId, attachedTabs: number[] }` enumerating every `tabId` for which Chrome currently has an attached debugger session **not owned by the extension's own in-memory state**. Extension computes this by calling `chrome.debugger.getTargets()` (Chromium CDP list-targets API — returns debugger sessions across all clients) and filtering to those the extension did NOT initiate.
       - For every `tabId` in `attachedTabs` that is NOT already covered by a journal quarantine entry, the host **adds a fresh quarantine entry** to the ownership map with `{ phase: "detaching_failed", sessionId: "orphan", reason: "chrome_error", since: now }` AND persists it to the quarantine journal via the normal write path. The `sessionId: "orphan"` sentinel signals an unknown-session quarantine produced by the probe — the clearance rules accept either a matching `sessionId` OR a probe-time discovery that the tab is no longer attached.
       - If the extension's `chrome.debugger.getTargets()` call returns tabs that ARE covered by the extension's in-memory `attached` state (meaning the extension still thinks it owns them, which is the post-port.onDisconnect-failure case), the extension releases them: calls `chrome.debugger.detach({ tabId })` for each, clears its own state, and INCLUDES those `tabId`s in the `attachedTabs` response anyway (the host still quarantines pessimistically until the probe confirms detach). A second probe round is issued after 2s to confirm clearance.
       - Host only binds its socket to drivers after the probe cycle completes. Until then, drivers observe `HOST_SPAWN_FAILED` with retry guidance.
       - This is a crash-safe recovery path: it does NOT depend on the prior host having written any journal entries and does NOT depend on `port.onDisconnect` having succeeded. Chrome's own debugger-list API is the authoritative source.
       - Integration test `boot-probe.integration.test.ts` (default CI): simulate `port.onDisconnect` throwing mid-detach for tab 42, then SIGKILL the host. Assert: new host boots, probe fires, extension reports tab 42 as attached, host seeds quarantine, extension force-detaches tab 42. A subsequent attach from a driver eventually succeeds once the quarantine clears.
  This replaces a best-effort teardown with a protocol-level handshake. A new driver trying to claim `tabId=42` cannot see an empty host-side map until Chrome has actually released the prior debugger session, preventing the `Debugger is already attached` race. The `detaching_failed` terminal state guarantees no false-free window.
- **Requester disconnect while `pending_consent` or `attaching`.** Under the same-client-only invariant (§8.6: cross-client pending attaches are short-circuited at the host and never reach extension participants), every participant for a given tab shares the same `leaseToken`. Therefore `abandon_attach { leaseToken }` for that tab's current requester is always a **terminal** event for the pending state.

  On driver disconnect, host sends the extension one `abandon_attach { leaseToken }` NM frame for each pending tab associated with that leaseToken. Extension removes **every** participant entry whose `leaseToken` matches (a single leaseToken may appear multiple times in `participants` if that driver fired multiple concurrent same-client attaches). Every removed participant receives `attach_ack { ok: false, tabId, leaseToken, attachRequestId, reason: "user_denied" }` with log note "requester disconnected". After removal:

  - `state[tabId].phase === "pending_consent"` → `participants` is now empty by construction (all shared the same leaseToken). Cancel the prompt (dismiss browser notification), transition to `idle`. No promotion path — there is no other client to promote.
  - `state[tabId].phase === "attaching"` → `participants` is now empty by construction. Let the in-flight `chrome.debugger.attach` finish:
    - On success → immediately `chrome.debugger.detach({ tabId })` (no owner left). Send `detached { sessionId, tabId, reason: "unknown" }` to the host so the host's `inFlight` abandoned branch (§8.5 rule 2 `abandoned === true`) completes cleanup. Transition to `idle`.
    - On failure → transition to `idle`. No detach needed.
  - For `attached` or `idle`, `abandon_attach` is a no-op for the pending-state path (but the `attached` case is handled separately by owned-tab detach — see next bullet).
- Extension MUST reply with `abandon_attach_ack { leaseToken, affectedTabs: [...] }` listing every `tabId` whose state it modified. Host uses this ack to guarantee no zombie pending-attach persists past the driver disconnect before releasing its own pending-state records.
- **Host also still performs the owned-tab detach** described above: for every `tabId` where the disconnecting `leaseToken` was the `attached` phase owner, host sends a `detach` NM frame and waits for extension's `chrome.debugger.detach` to complete before clearing the host-side ownership map.
- **Crash-path cleanup — one authoritative mechanism (`port.onDisconnect`)**: when the native host dies (crash, kill, planned exit), the **authoritative** signal in the extension is `port.onDisconnect` on the NM port. The required handler (§8.4) iterates every `attached` tab in the extension's in-memory state and calls `chrome.debugger.detach({ tabId })` for each. This is the only mechanism that reliably releases Chrome's debugger state on host death — per Chrome's documented behavior, `chrome.debugger.onDetach` does NOT automatically fire for every attached tab when the native messaging host dies; that event only fires for other reasons (user opened DevTools, tab closed, target canceled). Earlier drafts implied onDetach would fire on host crash; that was incorrect and has been removed. Extensions MUST drive detach from `port.onDisconnect` explicitly — if the handler is missing or fails, tabs can remain in Chrome's attached state indefinitely. The host-side assumption is the same: host death → extension `port.onDisconnect` runs → Chrome debugger state is released → next host instance boots with a clean slate.

**Extension-initiated detach reconciliation (zombie-lease prevention)**

The lease map has a third state transition beyond "driver attached" and "driver disconnected": the debugger session can end while **both** driver and host are still alive. Causes include:

- `Page.frameNavigated` to a private origin → extension auto-detaches (§7.4 Layer 2).
- `chrome.debugger.onDetach` fires with `reason = "target_closed"` (tab closed) or `"canceled_by_user"` (user opened DevTools, which force-detaches other clients).
- Extension reload while host survives (rare but possible during development).

In all of these, the extension sends a `detached` NM frame (defined in §6.1) to the host with the affected `sessionId`, `tabId`, and reason. Host response — **with full tuple validation**:

1. Look up `ownership[tabId]`. If absent → log + drop (extension and host got out of sync; defer to the next reconnect for GC).
2. **Tuple check**: compare the frame's `sessionId` to `ownership[tabId].sessionId` (for `committed` phase) or `ownership[tabId].sessionId` (for `detaching_failed` phase, which still records the prior session). If they differ → **do not mutate ownership**. Log as "stale detached for retired session" and drop the frame. This prevents a late-arriving `detached { oldSessionId, tabId }` from evicting a newer owner that has already reattached to the same tab with a fresh `sessionId`.
3. If tuple matches and `ownership[tabId].phase === "committed"` → remove the ownership entry.
4. If tuple matches and `ownership[tabId].phase === "detaching_failed"` → treat as the outstanding recovery completing successfully: remove the ownership entry (no longer quarantined). Log as "detaching_failed cleared via extension-initiated detached".
5. Fail every in-flight operation on that `sessionId` with `cdp_error { code: -32000, message: "Session detached: ${reason}" }`. Driver-side `error-translator` maps this to `STALE_REF` (reattachment needed) or `PERMISSION` (for `private_origin`).
6. Emit a `session_ended { sessionId, tabId, reason }` frame on the owning driver's channel (see §6.1 `DriverFrame`). The driver's error-translator maps this to `STALE_REF` (for `tab_closed`, `devtools_opened`, `extension_reload`, `navigated_away`, `unknown`) or `PERMISSION` (for `private_origin`). This replaces the prior `Koi.sessionDetached` `cdp_event` path — the driver channel has a first-class frame for it now.

After this, the tab is attachable by any client again (subject to consent rules in §8.6). No zombie lease can persist past an extension-initiated detach, AND no live owner can be evicted by a stale/misrouted detached frame.

**`detach_ack` reconciliation** (host-initiated detach from §8.5 owner-disconnect cleanup) uses the same tuple binding:

1. Host tracks each outstanding `detach { sessionId, tabId }` in a `Map<sessionId, { tabId, sentAt }>` keyed on the specific `sessionId` being torn down (not on `tabId` alone — same race reasoning).
2. On `detach_ack { sessionId, tabId, ok, reason? }` arrival:
   - Look up the outstanding detach by `sessionId`. If absent → log + drop (stale ack).
   - **Tuple check**: ack's `tabId` must match the outstanding entry's `tabId`. On mismatch, log as protocol error, do not mutate ownership.
   - If match → apply the §8.5 detach-ack rules against `ownership[tabId]` only if the current ownership's `sessionId` still matches. If ownership has already moved to a newer `sessionId` (another reattach happened), drop the ack's ownership effect: the earlier session is already gone by other means.

**What this does not do**

- No preemption / takeover in Phase 1. If driver A holds the lease and is idle, driver B can't force-evict A. Phase 2 adds `attach { mode: "force" }` with audit-log entry.
- No cross-host coordination. Two hosts attached to the same browser (shouldn't happen — only one NM port per extension instance) would each see their own `tabId` namespace; in practice §8.3 + §8.4 prevent this.

### 8.6 Consent model (clean split)

Attach consent has two distinct grant classes with different storage, scope, and lifetime:

| Grant | Storage | Scope | Cleared by |
|-------|---------|-------|------------|
| **`allow_once`** | `chrome.storage.session` (lost when service worker dies / browser restarts) | The specific `tabId` for the duration of its current navigation — invalidated on any `Page.frameNavigated` main-frame event | Browser restart, extension reload, explicit "revoke all" action, or navigation |
| **`always`** | `chrome.storage.local` (persists across browser restarts) | Per-origin (scheme + host + port) | User action in extension options page, `bunx @koi/browser-ext uninstall`, extension removal. **Re-install DOES clear all `always` grants** via the installId handshake (§8.7): every fresh install generates a new `installId`, and the extension wipes all grants on installId mismatch. This is a deliberate security choice — reinstall is treated as a revocation event. |
| **deny** | not stored — user can re-deny next time | Current attach attempt only | N/A (not persisted) |

**Per-tab attach state machine**

Extension maintains `Map<tabId, TabAttachState>`:

```typescript
type Participant = { readonly leaseToken: string; readonly attachRequestId: string };

type TabAttachState =
  | { phase: "idle" }
  | { phase: "pending_consent";   documentId: string; origin: string; participants: readonly Participant[]; startedAt: number }
  | { phase: "attaching";         documentId: string; origin: string; participants: readonly Participant[]; clientId: string }
  | { phase: "attached";          documentId: string; origin: string; clientId: string; sessionId: string };
// NOTE: `detaching_failed` is a HOST-side state (see §8.5) — not tracked
// here. When the host enters detaching_failed for a tab, the extension has
// already processed chrome.debugger.detach (success or fail) and returned to
// `idle` from its own perspective; the refusal to re-attach is enforced
// exclusively at the host socket layer via `attach_ack.reason = "already_attached"`
// with the `currentOwner` field omitted. The extension does not need to model the
// recovery window because any attach frame that would have reached it is
// rejected at the host.
```

- `participants` is an ordered list; every entry is `{ leaseToken, attachRequestId }` from a pending `attach` frame. **Cross-client arbitration is the host's responsibility, not the extension's**: the host guarantees (§8.5 rule 1, "Pending-window cross-client check") that every participant in a single `pending_consent`/`attaching` state shares the same `leaseToken` — different-client concurrent attaches are short-circuited at the host before forward and never reach the extension participants list. Consequently, `participants[0].leaseToken === ... === participants[n].leaseToken` for any non-empty participants list. What varies across entries is `attachRequestId` — the extension queues multiple retries/parallel-attaches from the same driver.
- `participants[0]` is the original requester; subsequent entries are later same-client waiters in arrival order. Every terminal path MUST reply to **every** participant with an `attach_ack` carrying that participant's `{ tabId, leaseToken, attachRequestId }` tuple so the driver can correlate the response with its outstanding attach promise. Each participant replied to exactly once per terminal transition.
- In the `attaching` phase, `clientId` equals every participant's `leaseToken` (see cross-client invariant above). All participants, differing only in `attachRequestId`, converge onto the same committed owner on success. On failure, every participant gets the same terminal reason.
- `documentId` is Chrome's [`webNavigation.documentId`](https://developer.chrome.com/docs/extensions/reference/api/webNavigation#type-OnCompletedDetails) — a stable per-document UUID that changes on **every** new document navigation (hard reload, cross-origin nav, same-origin nav creating a new document, back/forward to a different document). Unlike `Page.frameTree.frame.id`, it is (a) available **without a debugger attach**, (b) exposed directly on `chrome.webNavigation` events (`onCommitted`, `onCompleted`, `onDOMContentLoaded`), and (c) strictly per-document, not per-frame.
- Retrieve via `chrome.webNavigation.getAllFrames({ tabId })` (no attach required), then find the top-level frame (`parentFrameId === -1`) and read its `documentId`. Also cache recent `webNavigation.onCommitted` events per-tab so in-flight-during-prompt revalidation is O(1).
- `clientId` (in `attached`) is the requesting driver's `leaseToken` (§8.5).

**Attach-request flow**

1. Driver sends `attach { tabId, leaseToken, attachRequestId, reattach? }`. `attachRequestId` is generated fresh per attach call (`crypto.randomUUID()`); drivers that issue multiple concurrent attaches on the same tab MUST use a distinct `attachRequestId` per call. The optional `reattach` field is a string enum (see §6.1): `"consent_required_if_missing"` (default for auto-reconnect — suppresses the interactive prompt and surfaces `consent_required` if no grant covers the origin), `"prompt_if_missing"` (explicit opt-in to re-prompt), or omitted/`false` (normal first attach — always prompts when no grant exists). Driver sets `reattach: "consent_required_if_missing"` when auto-reconnect (§9.2) revisits a previously-attached tab.
2. Extension reads the tab's current main-frame document via `chrome.webNavigation.getAllFrames({ tabId })` (does NOT require debugger attach). Finds the main frame (`parentFrameId === -1`). Captures `(documentId, url)` → derives `origin` from `url`. If `getAllFrames` returns empty (tab hasn't committed a navigation — new tab page, pre-commit), respond `attach_ack { ok: false, tabId, leaseToken, attachRequestId, reason: "tab_closed" }` with log note "no main-frame document yet; retry after page load".
3. **Private-origin gate (precedes all grant/consent logic — Layer 2 of §7.4)**: check the captured `origin` against the blocklist (`localhost`, `*.local`, `*.internal`, `*.corp`, `*.home.arpa`, plus RFC1918 / RFC4193 / loopback / link-local IP literals). If the origin matches the blocklist:
   - Check `chrome.storage.local.koi.privateOriginAllowlist` — a **separate** storage location from the normal `always` grants map, reachable only via the extension's options page "Private-origin exceptions" section (never written by the `Allow once` / `Always` consent prompt). If the origin is in this explicit allowlist → fall through to the normal dispatch.
   - Otherwise → reply `attach_ack { ok: false, tabId, leaseToken, attachRequestId, reason: "private_origin" }` **immediately**. Do not read the normal grants store. Do not enter `pending_consent`. Do not fire a prompt under any `reattach` policy (not even `"prompt_if_missing"`). The `Allow once` and `Always` choices that users click in the normal browser notification MUST NOT write grants that cover blocked origins; the extension's storage-write path for those grants explicitly refuses to persist a grant whose origin is in the blocklist. The ONLY way to reach a private origin is via the separate options-page "Private-origin exceptions" UI which requires a deliberate user action distinct from mid-attach consent.
4. Dispatch on `state[tabId].phase`:
   - **`attached`**: if `clientId === leaseToken` → respond `attach_ack { ok: true, tabId, leaseToken, attachRequestId, sessionId: <existing> }` (idempotent; the driver is allowed to re-request and will get a fresh response keyed to this `attachRequestId`). If `clientId !== leaseToken` → respond `attach_ack { ok: false, tabId, leaseToken, attachRequestId, reason: "already_attached", currentOwner: { clientId, since } }`.
   - **`attaching`** or **`pending_consent`**: **append the full `{ leaseToken, attachRequestId }` participant entry unconditionally** — no dedup. If the same `{ leaseToken, attachRequestId }` tuple is already present (exact duplicate retry), treat it as a no-op (protocol-level replay protection); that tuple has already got its promise awaiting a reply.
   - **`idle`**:
     - Check `chrome.storage.local` for `always` grant on `origin` → if present, transition to `attaching { participants: [{leaseToken, attachRequestId}], clientId: leaseToken }`, proceed to step 5.
     - Check `chrome.storage.session` for `allow_once` grant keyed on `(tabId, documentId)` → if present, same transition.
     - Else (no grant exists):
       - The `attach` frame's `reattach` value chooses between two recovery paths.
         - `reattach: "consent_required_if_missing"` (default; what auto-reconnect uses after SW death) → reply immediately with `attach_ack { ok: false, tabId, leaseToken, attachRequestId, reason: "consent_required" }`. Driver maps this to `REATTACH_REQUIRES_CONSENT` so the agent can surface the gap to the user without triggering an unexpected browser prompt behind their back.
         - `reattach: "prompt_if_missing"` (caller explicitly opts in) → transition to `pending_consent` and show the prompt, same as a first-time attach. Drivers whose UX can handle a mid-session prompt (e.g. a foreground agent session with the user actively watching) use this to fully recover from `allow_once` loss without any agent-side escalation.
         - `reattach: false` / omitted (normal first attach) → transition to `pending_consent` with the prompt.
- So the `allow_once` recovery path is explicit: agents that need interactive recovery send `reattach: "prompt_if_missing"` and receive a fresh prompt; agents that want to surface the gap send the default `"consent_required_if_missing"` and receive `REATTACH_REQUIRES_CONSENT`. No allow_once session is stranded — both modes have a clear recovery action.
5. **`attaching` → `attached`**: call `chrome.debugger.attach({ tabId }, "1.3")`. On success, update `state[tabId] = attached { documentId, origin, clientId, sessionId }`. Then reply to every participant **individually, tagged with that participant's `attachRequestId`**:
   - Each participant with `leaseToken === clientId` → `attach_ack { ok: true, tabId, leaseToken, attachRequestId, sessionId }`. (Multiple such participants are possible if the same driver fired two parallel attaches; each gets its own reply.)
   - Each participant with `leaseToken !== clientId` → `attach_ack { ok: false, tabId, leaseToken, attachRequestId, reason: "already_attached", currentOwner: { clientId, since: now } }`.
   - On Chrome error (`Debugger is already attached` — rare, indicates lease-map drift), transition to `idle` and reply to **every** participant with `attach_ack { ok: false, tabId, leaseToken, attachRequestId, reason: "already_attached" }`.
- **Driver-side correlation invariant**: every `attach { attachRequestId: X }` frame the driver sends receives exactly one `attach_ack { attachRequestId: X }` in response. Drivers maintain `Map<attachRequestId, Deferred>` and resolve by that key. Two retries from the same driver for the same tab can therefore both be in flight safely — each resolves independently.

**Consent resolution**

When the consent prompt resolves (Allow once / Always / Deny / Timeout):
1. Re-check the tab's current document via `chrome.webNavigation.getAllFrames({ tabId })` → main-frame `documentId`.
2. If current `documentId !== state[tabId].documentId` → the tab navigated during the prompt → discard consent, transition back to `idle`, reply to **every participant** with `attach_ack { ok: false, reason: "user_denied" }` + log note "consent discarded: tab navigated during prompt". Caller may retry.
3. Else, on `Allow once`: write `chrome.storage.session[key(tabId, documentId)] = true`, transition to `attaching { participants, clientId: participants[0] }`, proceed.
4. On `Always`: write `chrome.storage.local[origin] = { grant: "always", grantedAt: now }`, transition to `attaching { participants, clientId: participants[0] }`, proceed.
5. On `Deny`: transition to `idle`, reply to **every participant** with `attach_ack { ok: false, reason: "user_denied" }`.
6. On 60s timeout: transition to `idle`, reply to **every participant** with `attach_ack { ok: false, reason: "timeout" }`.

**Cancellation / state cleanup**

- Tab closed (`chrome.tabs.onRemoved`): clear `state[tabId]`; if phase was `pending_consent` or `attaching`, reply to **every participant** with `attach_ack { ok: false, reason: "tab_closed" }`.
- Main-frame navigation (`chrome.webNavigation.onCommitted` with `frameId === 0`, and the event's `documentId` differs from `state[tabId].documentId`): if `state[tabId].phase === "pending_consent"` or `"attaching"`, discard the pending state, transition to `idle`, reply to **every participant** with `attach_ack { ok: false, reason: "user_denied" }` + log note "tab navigated during attach". If `state[tabId].phase === "attached"`, the navigation triggers a re-check (new `documentId`) — if the new origin is not covered by an `always` grant, extension proactively detaches via `chrome.debugger.detach` and sends a `detached { reason: "navigated_away" }` NM frame, which the host translates into a `session_ended` frame on the owning driver's channel (§6.2).
- Service worker death: all `pending_consent` and `attaching` state lost (they live only in SW memory); on SW respawn, those drivers receive `REATTACH_REQUIRES_CONSENT` when they retry.
- Extension reload: same as SW death. `always` grants persist across SW restart and extension reload. They are cleared only by: (a) user revoke action in options page, (b) successful `bunx @koi/browser-ext uninstall` via admin channel, (c) `installId` mismatch on the next `host_hello` (reinstall with a new installId triggers a wipe — see §8.7).
- Full extension uninstall (user removes the extension via `chrome://extensions`): Chrome clears all `chrome.storage.local` for this extension, so all grants are gone.

**Revocation**

- User clicks "Revoke" on an origin in extension options page → `chrome.storage.local` entry removed by the extension directly (no NM frame needed — it's a local action). If any tabs are currently `attached` to that origin, extension proactively `chrome.debugger.detach`es them and emits `detached { reason: "private_origin" }` NM frames, which the host translates to `session_ended` on the affected drivers.
- `bunx @koi/browser-ext uninstall` revocation flow (requires an active NM port — i.e. the extension is running):
  1. CLI connects to the running host via its unix socket. The `hello` frame carries both `token` (from `~/.koi/browser-ext/token`) **and** an `admin: { adminKey }` block whose value comes from `~/.koi/browser-ext/admin.key` (mode `0o600`, written at install time as a separate file). Host validates both independently:
     - `token` mismatch → `hello_ack { ok: false, reason: "bad_token" }`, connection closed.
     - `token` ok but `admin.adminKey` present and mismatching → `hello_ack { ok: false, reason: "bad_admin_key" }`, connection closed.
     - `token` ok and no `admin` block → `hello_ack { ok: true, role: "driver" }`. Host marks this connection as non-privileged; any subsequent privileged operation is rejected at the host before any NM frame is emitted.
     - `token` ok and `admin.adminKey` matches → `hello_ack { ok: true, role: "admin" }`. Host marks this connection as privileged; it may request `admin_clear_grants`.
  2. CLI (as admin role) requests revocation. Host sends `admin_clear_grants { scope: "all" }` on the NM channel to the extension.
  3. Extension clears `chrome.storage.local` in full, `chrome.debugger.detach`es every currently-attached tab, and replies `admin_clear_grants_ack { clearedOrigins, detachedTabs }`. Each detached tab also triggers a `detached` NM frame per the normal flow, so any connected drivers get `session_ended`.
  4. Host forwards the ack summary to the CLI, which prints the list of cleared origins to the terminal.
- **Offline uninstall is NOT supported in Phase 1.** If no NM port is active (extension disabled or browser not running), `uninstall` **aborts before touching any local artifact**. Exit code is non-zero. The only supported path is: user enables the Koi Browser Extension in the browser, then runs `bunx @koi/browser-ext uninstall` again. The admin frame then clears `chrome.storage.local` grants in the same run that removes local files — atomic from the user's perspective.
- Error text on offline invocation:
  ```
  $ bunx @koi/browser-ext uninstall
    Error: Koi Browser Extension is not reachable — cannot revoke persistent grants.

    Persistent `always` grants live in the browser's storage and must be
    cleared via the extension before local artifacts are removed.

    Please:
      1. Open Chrome (or your Chromium-family browser) with the Koi Browser
         Extension enabled in chrome://extensions.
      2. Re-run: bunx @koi/browser-ext uninstall

    Alternatively, if you have already removed the extension and only want
    to clean up local files, manually delete ~/.koi/browser-ext/ and the
    NM manifests listed by `bunx @koi/browser-ext status`. You will also
    need to clear any persistent grants the extension left in browser
    storage by visiting chrome://extensions and clicking "Clear" under
    the extension's site data section before reinstalling.
  ```
- This removes all `--force-local-only` / offline-marker complexity from the Phase 1 surface. The spec's invariant is: **every successful `uninstall` run has cleared persistent `always` grants**; no partial-success path exists. A user who has already uninstalled the extension before running `uninstall` is outside the supported flow and gets manual cleanup instructions.
- Phase 2 may reintroduce an offline path if a deterministic revocation handshake can be built (e.g., via a Chrome `managed_storage` JSON file under `chrome://policy` that administratively forces the extension to clear grants on next boot — available for enterprise-managed browsers but not for consumer installs). Phase 2 is also when durability across uninstall-then-reinstall cycles will be reconsidered in full.

**Acceptance test** (default CI):

- `uninstall-offline-refused.integration.test.ts` — with the mock extension not running, invoke `bunx @koi/browser-ext uninstall`. Assert: non-zero exit, no NM manifest removed, no token deleted, no quarantine touched, no file modified; stderr contains the guidance above.
- `uninstall-online-clears-grants.integration.test.ts` — set up `chrome.storage.local` with `always` grants for `example.com`, ensure the extension is connected. Run `uninstall`. Assert: `admin_clear_grants_ack` received with `clearedOrigins: ["example.com"]`, all local artifacts removed, and a subsequent attempt to attach to `example.com` (after a reinstall scenario — the test re-runs install and the extension restarts) receives `pending_consent` with a fresh prompt, not an auto-allow.

### 8.7 Uninstall

```
$ bunx @koi/browser-ext uninstall
  Removing NM manifest from each Chromium browser directory  ✓
  Clearing browser-side grants via admin_clear_grants        ✓  (12 origins cleared)
  Removing ~/.koi/browser-ext/                                 ✓
  (Windows registry — N/A on current platform)
  Extension still installed — remove via chrome://extensions if desired.
```

**Reinstall revocation — installId handshake (defense-in-depth against the offline-uninstall case)**

Even though Phase 1 uninstall fails closed if the extension is unreachable (§8.7 text above), an installId-based revocation guard is also wired into normal startup so that a hand-deleted `~/.koi/browser-ext/` + manual reinstall cycle cannot silently resurrect prior grants:

- `bunx @koi/browser-ext install` generates a fresh 32-byte `installId` and writes it to `~/.koi/browser-ext/installId` (mode `0o600`). Every subsequent install run generates a new `installId`.
- The host reads `installId` on startup and includes it in every `host_hello` frame (§6.5 schema).
- **Per-NM-connection check (not per-SW-boot)**: after **every** `host_hello` received by the extension — whether on initial SW boot or on a later reconnect within the same SW lifetime (e.g. host dies, new host spawns, existing SW reconnects via `ensureConnected`) — the extension runs this gate **synchronously before marking the NM port ready for attach traffic**:
  - Read stored `koi.installId` from `chrome.storage.local`.
  - If stored `installId` is missing OR differs from `host_hello.installId`:
    1. Clear `chrome.storage.local.koi.alwaysGrants`, `chrome.storage.local.koi.privateOriginAllowlist`, `chrome.storage.session.koi.allowOnceGrants`. Await all three writes.
    2. Write the incoming `installId` as the new stored value. Await.
    3. Log: "Install changed — all persistent grants revoked".
    4. Only then mark the NM port as ready; any earlier-queued driver attach requests are processed AFTER the wipe completes.
  - If stored matches → no revocation; mark port ready immediately.
- The port-ready state is an explicit flag in the extension's SW memory (`portReady: boolean`). Any inbound `list_tabs` / `attach` / `detach` / `cdp` frame that arrives while `portReady === false` is queued in an in-memory bounded buffer (max 100 frames per port, oldest dropped with an audit log on overflow). When `portReady` flips to true, queued frames are drained in arrival order.
- Same-SW reconnect scenario (the one Codex flagged): worker stays alive, old host dies, new host spawns with a new `installId`. Extension's `onDisconnect` → `ensureConnected` → new NM port → receives `host_hello` from new host → installId mismatch → wipe runs → port marked ready. Any attach attempts from drivers that were already connected when the wipe ran now go through the fresh-consent path, not the stale-grant path.
- A user who goes through the "rm -rf ~/.koi/browser-ext/ → run install again" path gets a new `installId` on disk; the extension sees it doesn't match the stored one and wipes. A user who deletes the extension entirely → `chrome.storage.local` is automatically cleared by Chrome; on reinstall the extension starts fresh.
- This closes the revocation gap for: user disables extension + runs `uninstall` (aborted, user manually cleans up) + re-enables extension + reinstalls → fresh `installId` → extension wipes. AND the same-worker reconnect case: host replaced while SW lives → next `host_hello` triggers the wipe.

Acceptance test (`uninstall-reinstall-revocation.integration.test.ts`, default CI):

1. Start with `always` grant for `example.com` and a `privateOriginAllowlist` entry for `http://localhost:3000` in `chrome.storage.local`.
2. Stop the host (simulate user-disabled extension / CLI-uninstall-aborted scenario).
3. Hand-delete `~/.koi/browser-ext/installId` and re-run `bunx @koi/browser-ext install` (generates a new `installId`).
4. Restart the extension (new host boots, new `installId`).
5. Driver attempts attach to `example.com` → `pending_consent` (fresh prompt), NOT silent auto-allow.
6. Driver attempts attach to `http://localhost:3000` → `private_origin` reason, allowlist gone.
7. `chrome.storage.local.koi.alwaysGrants` and `.privateOriginAllowlist` are empty.

## 9. Error handling + reconnection

### 9.1 New `KoiError` codes

| Code | When | Retryable | Guidance |
|------|------|-----------|----------|
| `EXT_NOT_INSTALLED` | NM port open, no extension messages in 5s | no | "Install the Koi browser extension" |
| `EXT_WRONG_VERSION` | Extension semver outside host range | no | "Refresh the unpacked extension: (1) `bunx @koi/browser-ext install` to regenerate `~/.koi/browser-ext/extension/`, (2) open chrome://extensions, (3) click the reload icon on Koi Browser Extension (or remove + Load unpacked again)." |
| `EXT_USER_DENIED` | `attach_ack.reason=user_denied` | no | "User denied the attach. Ask them to allow the origin." |
| `TRANSPORT_LOST` | Socket EOF / NM pipe broken mid-session | yes (auto) | "Reconnecting…" (handled internally) |
| `HOST_SPAWN_FAILED` | No live host found in `~/.koi/browser-ext/instances/`, or host exits before `hello_ack` | no | "Make sure Chrome (or your selected browser) is open and the Koi Browser Extension is enabled. Run `bunx @koi/browser-ext status` to diagnose." |
| `HOST_AMBIGUOUS` | Multiple live hosts and no `select` narrowing provided | no | "Multiple Koi browser extensions are active. Narrow selection via `createExtensionBrowserDriver({ select: { pid: <N> } })` (authoritative) or `{ select: { name: 'personal' } }` (matches the label configured in the extension's options page). Available hosts are listed in the error's `alternatives` field as `{ pid, name, browserHint, extensionVersion }`." |
| `REATTACH_REQUIRES_CONSENT` | After a reconnect (host crash or SW respawn), a previously-attached tab no longer has its `allow_once` grant because `chrome.storage.session` was cleared. Tab has no `always` grant for its origin. | no (user action required) | "Tab requires re-consent after extension restart. Either (1) ask the user to re-approve the attach prompt that should have appeared, or (2) add the origin to the 'Always allow' list in the extension options page to avoid prompts on future reconnects." |

All other CDP errors pass through `@koi/browser-a11y`'s existing translator → `TIMEOUT`, `STALE_REF`, `PERMISSION`, `EXTERNAL`, `INTERNAL`.

### 9.2 Auto-reconnect

```
TRANSPORT_LOST detected
  → all active sessions marked invalid
  → future ops return STALE_REF with guidance "re-snapshot after reconnect"
  → exponential backoff: 100ms, 400ms, 1.6s, 6.4s, 25s (5 attempts)
     ├─ SUCCESS (transport): reconnected, sessions invalid — agent re-snapshots on next call
     │   - If the re-snapshot/re-attach hits a tab whose only grant was `allow_once` (which
     │     was evicted with the service worker), attach returns
     │     `REATTACH_REQUIRES_CONSENT`. Transport recovery ≠ operation recovery. Callers
     │     must treat transport success as necessary-but-not-sufficient for tab continuity.
     └─ FAIL: surface INTERNAL { code: "TRANSPORT_LOST_GIVE_UP" }; caller must dispose + recreate driver
```

**Why no mid-session state restore**: `chrome.debugger` reattach requires user consent; Playwright `Page`/`BrowserContext` assume continuous CDP. Invalidate-and-re-snapshot reuses `tool-browser`'s existing `STALE_REF` idiom.

**Two distinct reconnect failure modes** (for callers):

| Mode | Trigger | Recovery |
|------|---------|----------|
| `TRANSPORT_LOST` → reconnect SUCCESS → `STALE_REF` | Host crash, NM port drop | Automatic re-snapshot in `tool-browser`'s usual pattern |
| `TRANSPORT_LOST` → reconnect SUCCESS → `REATTACH_REQUIRES_CONSENT` | Service worker died, `allow_once` grant lost for a previously-attached tab | User must re-approve the consent prompt, OR add origin to "Always allow" list |
| `TRANSPORT_LOST_GIVE_UP` | 5 backoff attempts exhausted | Caller disposes + recreates driver, probably surfaces "browser extension not responding" to the user |

### 9.3 Host watchdog

- Uses the `ping`/`pong` control frames defined in §6.5 (NM channel only — not on the driver↔host channel).
- Host sends `{kind:"ping", seq:N}` NM frame every 5s; extension must reply `{kind:"pong", seq:N}` within 2s.
- 3 consecutive unanswered pings → host closes NM port + exits cleanly → driver observes socket close → `TRANSPORT_LOST` → reconnect cycle.
- Host never relaunches Chrome.

### 9.4 Timeouts

- NM handshake: 5s → `HOST_SPAWN_FAILED`.
- Extension first message: 5s → `EXT_NOT_INSTALLED`.
- Per-tab attach consent: 60s → `attach_ack.reason=timeout`.
- Per-command CDP timeouts: inherited from `@koi/browser-a11y` min/max table (3s default, 10s max).

## 10. Testing strategy

### 10.1 Unit (`bun:test`, colocated)

**`@koi/browser-a11y`** — port v1 tests as-is: `a11y-serializer.test.ts`, `error-translator.test.ts`, `ref-resolution.test.ts`.

**`@koi/browser-playwright`** — port v1 tests; add one case for `wsEndpoint` transport.

**`@koi/browser-ext`** — new:
- `unix-socket-transport.test.ts` — framing round-trip, fragmentation, oversized-frame rejection.
- `native-host/host.test.ts` — bridge logic, auth rejection, stale-socket cleanup.
- `native-host/install.test.ts` — manifest write, per-browser dir, idempotent re-install, symmetric uninstall, absolute Node path baked into wrapper, wrapper rejects install when Node < 20.11, wrapper rejects when Node binary not found.
- `native-host/browsers.test.ts` — per-platform path table (7 browsers × 3 platforms).
- `native-host/control-frames.test.ts` — **new coverage for §6.5**:
  - `extension_hello`/`host_hello` version negotiation happy path.
  - Protocol mismatch → host closes NM port, driver receives `TRANSPORT_LOST` that translates to `EXT_WRONG_VERSION` after reconnect exchange.
  - `ping`/`pong` keep-alive: 3 consecutive missed pongs → host exits cleanly.
  - Keep-alive continues to fire during long chunked transfers; ping-pong timing not blocked by high-volume chunk traffic (interleave test with a 5 MB screenshot mid-flight).
  - Chunk-buffer integrity under control-frame interleaving: `chunk` frames and `ping`/`pong` frames arriving in arbitrary order must produce the same reassembled payload.
- `auth.test.ts` — token lifecycle, permission enforcement.
- `discovery.test.ts` — `instances/<pid>.json` atomic write (only after `ready=true`), stale-file GC (dead pid or missing socket), crash recovery, absent-dir path surfaces `HOST_SPAWN_FAILED`, multi-host cohabitation (two browsers both alive) surfaces `HOST_AMBIGUOUS` with `alternatives` populated unless `select` provided, `select.pid` narrowing (authoritative) / `select.name` narrowing (unique-label match) / `select.browserHint` narrowing (best-effort — test that two Chrome profiles both reporting `"Google Chrome"` produce `HOST_AMBIGUOUS` even with `browserHint` provided), `ECONNREFUSED`-on-connect unlinks stale file and re-scans, concurrent startup of two hosts produces two distinct files (no shared-writer race), concurrent shutdown of two hosts deletes only each's own file.
- `driver.test.ts` — delegation correctness, surfaces 5 new error codes.
- `chunking.test.ts` — chunk envelope round-trip (result + event), concurrent oversized events of same method disambiguated by UUID `correlationId`, partial-chunk 30s timeout.

Coverage target: 80% per `bunfig.toml`.

### 10.2 Integration (`__tests__/`)

- `native-host.integration.test.ts` — real subprocess, real socket, simulated NM stdin/stdout.
- `extension-sim.integration.test.ts` — full driver→host→(mock extension)→real Playwright→real Chromium with `--remote-debugging-port=0`. Validates end-to-end navigate + snapshot + **`Page.captureScreenshot` with `fullPage: true` on a ≥2 MB page** (exercises the chunking path with ≥3 chunks round-trip).
- `attach-lease.integration.test.ts` — two driver clients connect to one host, both call `attach(tabId=42)` concurrently:
  - Exactly one succeeds with `attach_ack.ok = true`; other gets `attach_ack { ok: false, reason: "already_attached", currentOwner: { clientId, since } }`.
  - Idempotent reattach: winner calls `attach(tabId=42)` again with its own `leaseToken` → receives the existing `sessionId` (no duplicate CDP attach).
  - Winner disconnects (socket close) → host explicitly calls `chrome.debugger.detach` for each of winner's owned tabs BEFORE clearing the ownership map → loser retries `attach(tabId=42)` → succeeds without `Debugger is already attached` error.
  - `detach` from non-owner → rejected with log entry, no state change.
- `extension-detach.integration.test.ts` — zombie-lease prevention:
  - Driver attaches tab 42. Host ownership map shows `{ tabId: 42, clientId, sessionId }`.
  - Mock extension fires an `extension_initiated_detach` (simulated via navigation to `http://192.168.1.5/` triggering Layer 2 private-origin detach). Extension sends `detached { sessionId, tabId: 42, reason: "private_origin" }` NM frame.
  - Host clears `tabId: 42` from ownership map. Any in-flight op on that `sessionId` rejects with `cdp_error` that translates to `PERMISSION`.
  - Driver receives `session_ended { reason: "private_origin" }` frame, flushes session state, surfaces `PERMISSION` to the agent.
  - A different driver calls `attach(tabId=42)` → succeeds (lease is released — not zombie).
  - Variants cover `reason: "tab_closed"`, `reason: "devtools_opened"`, `reason: "extension_reload"`.
  - **Stale-detached protection**: driver A attaches tab 42 → session_A. Tab navigates → extension detaches → driver A receives `session_ended`, releases. Driver B reattaches tab 42 → session_B committed. A delayed/duplicate `detached { sessionId: session_A, tabId: 42 }` NM frame arrives. Host compares frame's `sessionId` against current `ownership[42].sessionId` (= session_B), mismatch, drops the frame without mutation. Driver B's session remains intact. Test asserts `ownership[42]` unchanged and no `session_ended` sent to B.
  - **Stale detach_ack protection**: parallel scenario — owner A disconnect triggers `detach { sessionId: session_A, tabId: 42 }` to extension; extension's `detach_ack` is delayed. Meanwhile B reattaches and gets session_B. Delayed `detach_ack { sessionId: session_A, tabId: 42, ok: true }` arrives. Host's outstanding-detach lookup finds session_A, tabId matches, but `ownership[42].sessionId` is now session_B — host drops the ack's ownership effect.
- `pending-attach.integration.test.ts` — concurrent attach with consent prompt in flight. **All queuing is same-client only**; cross-client attempts are tested separately and expected to be rejected at the host without ever reaching extension waiters.
  - Mock extension: no prior grants. Tab 42 at `https://example.com`, documentId `D1`.
  - Driver A (leaseToken `LT_A`) calls `attach(42, attachRequestId: R1)` → extension captures `(documentId: D1, origin: example.com)`, transitions to `pending_consent`, fires prompt.
  - Before user responds, Driver A sends a concurrent same-client `attach(42, attachRequestId: R2)` (e.g. speculative retry or parallel call). Host forwards it; extension appends `{ leaseToken: LT_A, attachRequestId: R2 }` to `participants`. Host returns nothing to the R2 call yet.
  - Test variant 1 — tab navigates mid-prompt: simulate `webNavigation.onCommitted` with new `documentId D2`. Extension discards consent, transitions to `idle`, replies to BOTH R1 and R2 with `attach_ack { ok: false, tabId: 42, leaseToken: LT_A, attachRequestId: Rn, reason: "user_denied" }` + "tab navigated" log note.
  - Test variant 2 — user clicks "Allow once" before navigation: extension re-checks document (still D1), writes `(tabId, D1)` grant to `storage.session`, transitions to `attaching`, calls `chrome.debugger.attach`. R1 and R2 both receive `attach_ack.ok = true` with the same `sessionId` (idempotent — two attach calls from the same driver on the same tab both succeed with the same lease).
  - Test variant 3 — user clicks "Always" on origin "example.com": extension writes `origin` grant to `storage.local`. Later `attach` to a different tab at same origin succeeds without prompt (same-driver reuse).
  - Test variant 4 — **cross-client rejection, no extension involvement**: While Driver A is in `pending_consent`, a DIFFERENT Driver B (leaseToken `LT_B`) calls `attach(42, attachRequestId: R3)` on a separate authenticated socket. **Host short-circuits at §8.5 rule 1** (Pending-window cross-client check) and replies to B with `attach_ack { ok: false, tabId: 42, leaseToken: LT_B, attachRequestId: R3, reason: "already_attached" }` (no `currentOwner` — ownership hasn't committed yet). Assertions: (a) no NM frame was forwarded to the extension on B's behalf, (b) extension `participants` list still contains only `{ LT_A, R1 }` (and `R2` if variant 2-style prior), (c) Driver A's consent flow is unaffected.
  - Test variant 5 — requester-disconnect, same-client promotion: Driver A fires two same-client attaches (R1 first, R2 later), extension has `participants = [{LT_A, R1}, {LT_A, R2}]`. Driver A's socket closes. Host sends `abandon_attach { leaseToken: LT_A }`. Extension removes BOTH entries. Prompt is dismissed; no residual pending state. The "promotion to a different client" path described in prior drafts is removed — a single driver losing its socket ends the pending attach for that tab; no cross-client inheritance.
  - Test variant 6 — last requester disconnects during prompt: Driver A alone in `pending_consent` (single participant), disconnects. Host sends `abandon_attach`. Extension dismisses the browser notification, transitions to `idle`. No residual pending state.
  - Test variant 7 — requester disconnects during `attaching`: Driver A won consent (single participant), state is `attaching`, `chrome.debugger.attach` in flight. Driver A disconnects. `abandon_attach` arrives. The in-flight attach completes successfully; extension immediately detaches (no owner); transitions to `idle`. Host's `inFlight` entry was marked `abandoned`; when the late `attach_ack.ok=true` arrives at the host, host issues a compensating `detach` (§8.5 rule 2 abandoned branch).
- `consent-reattach.integration.test.ts` — exercises both reattach policies end-to-end:
  - **Variant A — default `"consent_required_if_missing"`**: mock extension starts with `allow_once` grant for tab 42 in `chrome.storage.session`. Driver created without `reattachPolicy` option (default applies). Driver attaches successfully. Test harness simulates SW restart (clears storage.session, reloads extension context). Driver's auto-reconnect succeeds at transport layer. Driver's next op triggers reattach to tab 42 → `attach` frame carries `reattach: "consent_required_if_missing"` → `attach_ack.ok = false, reason: "consent_required"` → driver surfaces `REATTACH_REQUIRES_CONSENT`. No browser prompt shown. Assert agent-facing error message includes guidance.
  - **Variant B — `"prompt_if_missing"`**: same scenario, but driver created with `createExtensionBrowserDriver({ reattachPolicy: "prompt_if_missing" })`. After SW restart, auto-reconnect's attach frame carries `reattach: "prompt_if_missing"` → extension enters `pending_consent` and fires a browser notification. Test harness simulates user clicking "Allow once" → attach succeeds with new `sessionId`. Assert the prompt fired and driver-side Promise resolves.
  - **Variant C — `onReattach` per-call override**: driver created with `onReattach: ctx => ctx.origin.startsWith("https://") ? "prompt_if_missing" : "consent_required_if_missing"`. After SW restart, reattach to an https origin fires a prompt; reattach to http://example.com surfaces `REATTACH_REQUIRES_CONSENT`. Assert both branches execute.
  - **Variant D — `always` grant present**: pre-set `always` grant for tab 42's origin in `chrome.storage.local`. After SW restart, reattach succeeds silently regardless of policy. Assert no prompt, no `consent_required` error.
- `reconnect-singleflight.integration.test.ts` — extension instance with both disconnect handler and `chrome.alarms` keepalive; test harness simulates port drop:
  - Fire disconnect handler and alarm tick concurrently → asserts exactly ONE `connectNative` call, ONE host spawn, ONE new `instances/` file.
  - Old host's instances file is removed when a new-generation file arrives; driver picks highest generation.
  - Late `extension_hello` with stale generation → host exits after handshake timeout, no discovery file written.
- `control-frames.integration.test.ts` — real Node subprocess, real socket, simulated NM stdin/stdout:
  - Version negotiation: start host with `supportedProtocols=[1]`, extension offers `[2]`; host closes pipe; driver receives `EXT_WRONG_VERSION`.
  - Watchdog: simulate extension stopping `pong` replies; host exits within (3 × 5s) + 2s tolerance; driver auto-reconnects and re-handshakes.
  - Interleaved control + chunk traffic: run a 5 MB screenshot chunk stream while exchanging `ping`/`pong` every 5s; assert both paths correct.
- `host-kill-recovery.integration.test.ts` — **host crash without prior warning, port.onDisconnect is the sole cleanup trigger**. Driver attaches tab 42 → committed. Test harness SIGKILLs the host subprocess. Asserts:
  - Extension's `port.onDisconnect` handler runs (test observes via injected spy on `chrome.debugger.detach`).
  - Extension calls `chrome.debugger.detach({ tabId: 42 })` — the release signal, NOT a reliance on `chrome.debugger.onDetach` firing.
  - After 1s backoff, extension calls `connectNative` → new host boots → new `instances/<newPid>.json` written.
  - Driver's auto-reconnect loop reconnects → new attach to tab 42 succeeds (not blocked by stale `already_attached` from Chrome's side — proof that detach actually ran).
  - Test injects a failure: make the extension's `port.onDisconnect` handler throw before completing all detaches. Assert: the uncompleted tabs show up as `detaching_failed` on the NEXT host's seeded quarantine after its reconnect and quarantine probe.
- `chunk-crash.integration.test.ts` — **mid-chunk host-death path**. Driver initiates `Page.captureScreenshot` that will require ≥5 chunks. Mock extension delivers chunks 0 and 1, then test harness `SIGKILL`s the host subprocess. Asserts:
  - Awaiting call rejects promptly (< 500ms from SIGKILL) with `TRANSPORT_LOST`.
  - Driver's chunk-buffer `Map` for the (sessionId, id) is empty (no leak).
  - Auto-reconnect succeeds within backoff window.
  - After reconnect, a fresh `browser.screenshot()` returns a complete screenshot (partial chunks from crashed session **not** replayed or concatenated with new chunks — proves no stale-buffer hazard).
  - Any active `Page`/`BrowserContext` handles surface `STALE_REF` on next use; tool-browser re-snapshots and continues.
  - Variant: instead of SIGKILL, test harness abruptly closes the NM pipe (simulating extension disable). Same assertions.
- `private-origin.integration.test.ts` — real Chromium tab, mock extension enforcing **Layer 2** (Phase 1 scope). The gate MUST run ahead of any grant lookup or consent prompt (see §8.6 step 3):
  - First-attach to a tab already at `http://localhost:3000` → `attach_ack.reason=private_origin`. No consent prompt fires. Test asserts no `pending_consent` state was entered and the browser-notification API was NOT called.
  - Same attach with `reattach: "prompt_if_missing"` → STILL `private_origin`. Prompt bypass applies only to non-blocklist origins. Test asserts no prompt shown even when the caller explicitly opts in.
  - Same attach with `reattach: "consent_required_if_missing"` → STILL `private_origin` (not `consent_required`). Blocklist takes precedence over grant lookup.
  - Attach to public tab, then navigate in the tab to `http://192.168.1.5/admin` → extension calls `chrome.debugger.detach`, emits `detached { reason: "private_origin" }` NM frame → host clears lease, emits `session_ended { reason: "private_origin" }` on the driver channel → driver surfaces `PERMISSION`. Test asserts the full chain end-to-end (NM frame sent, host lease map cleared, driver sees `session_ended`).
  - User clicks "Always" on consent prompt for a public origin that later redirects to a private origin: the `always` grant only covers the public origin — the grants-store write path refuses to persist blocklist origins. Test asserts `chrome.storage.local` never contains an `always` entry for the private origin after the redirect flow.
  - Private-origin allowlist exception: pre-populate `chrome.storage.local.koi.privateOriginAllowlist` with `http://localhost:3000` (simulating the options-page "Private-origin exceptions" UI). Attach now succeeds normally. Test asserts this separate storage location is the ONLY path that can reach a blocklist origin — the regular `Allow once` / `Always` flow never writes to it.
  - **Layer 1 tests are Phase 2** and live in that follow-up issue's spec.

### 10.3 E2E

- **Phase 1**: manual smoke checklist at `packages/drivers/browser-ext/docs/manual-e2e.md` — install, load unpacked extension, run smoke script, uninstall, on mac + Linux.
- **Phase 2**: automated via `chromium.launchPersistentContext({ args: ["--load-extension=…"] })`.

### 10.4 Golden queries + trajectory (required by CLAUDE.md)

1. **`Golden: @koi/browser-ext attach-and-snapshot`** — standalone, mocked Chrome.
2. **`Golden: @koi/browser-ext ext-user-denied`** — `EXT_USER_DENIED` → `STALE_REF` surfacing.
3. **Recorded cassette**: `browser-ext-use` in `packages/meta/runtime/scripts/record-cassettes.ts`. Full-loop: LLM tool call → attach sim → navigate → snapshot.

### 10.5 Security tests (table-driven)

- Token mismatch → `hello_ack.ok=false reason=bad_token`.
- Socket perm != `0o600` → driver refuses connect.
- NM frame > 1 MB without chunking header → host rejects, audit entry written.
- Chunked payload missing chunks 30s timeout → `TRANSPORT_LOST`.
- Private-origin tab → `attach_ack.reason=private_origin` unless allowlisted.
- Tab navigates mid-session to private origin → extension `chrome.debugger.detach` + NM `detached { reason: "private_origin" }` → host clears lease + driver receives `session_ended { reason: "private_origin" }`.
- (Phase 2 only) Private-IP subresource in public page → `Fetch.failRequest` with `AccessDenied`.
- (Phase 2 only) DNS-rebinding (public hostname resolves to private IP on 2nd request) → 2nd request blocked.

### 10.6 CI gate

```
bun run test --filter=@koi/browser-a11y
bun run test --filter=@koi/browser-playwright
bun run test --filter=@koi/browser-ext
bun run test --filter=@koi/runtime         # golden replay
bun run typecheck
bun run lint
bun run check:layers
bun run check:orphans
bun run check:golden-queries
bun run check:unused
bun run check:duplicates
```

## 11. Phases

### Phase 1 (this PR)

1. Extract `@koi/browser-a11y` (L0u).
2. Port `@koi/browser-playwright` from `archive/v1`. Minimal v2 compliance pass (TS 6 strict, isolatedDeclarations, ESM `.js` paths, Biome). Accept a pluggable CDP transport / `wsEndpoint`.
3. Build `@koi/browser-ext`:
   - `driver.ts` + `unix-socket-transport.ts` (local WS bridge per §6.7).
   - `native-host/` subsystem: `host.ts`, `message-reader.ts`, `install.ts`, `browsers.ts` (table only — Chrome + Brave validated; others stubbed with untested paths), `cli.ts` (install | uninstall | status).
   - `auth.ts` + token lifecycle.
   - `discovery.ts` — `instances/<pid>.json` read/write/scan/GC.
   - `chunking.ts` — session-scoped chunk reassembly.
   - Control frames: `extension_hello`/`host_hello`/`ping`/`pong` handlers.
   - `bin/koi-browser-ext.ts`.
   - `extension/` MV3 source: `manifest.json` with pinned `key`, `service-worker.ts` (NM port + `chrome.alarms` keepalive + attach-time URL check + `Page.frameNavigated` guard), options page (minimal — allowlist editor + instance name).
   - `build.ts` (esbuild → `dist/extension/`).
4. Tests:
   - Unit (colocated): transport framing, host bridge, install, browsers table, control frames, auth, discovery, chunking, driver.
   - Integration (`__tests__/`): `native-host.integration.test.ts`, `extension-sim.integration.test.ts`, `chunk-crash.integration.test.ts`, `control-frames.integration.test.ts`.
   - Default gate: `idle-resume.integration.test.ts` (90s MV3 lifecycle against real Chromium via `launchPersistentContext` — **required before release**; production MV3 keepalive correctness cannot be validated without it).
5. Golden queries (2 standalone) + 1 recorded cassette in `@koi/runtime`.
6. Manual E2E smoke checklist committed at `packages/drivers/browser-ext/docs/manual-e2e.md` — includes idle-resume manual verification.
7. Wire into `@koi/runtime` (dep + `createRuntime` compose).
8. Docs: `docs/L2/browser-ext.md` + `docs/L2/browser-a11y.md` + port `docs/L2/browser-playwright.md` from v1. The browser-ext doc's Security section MUST document the Layer-1 gap.

**Phase 1 scope limit**: mac + Linux, Chrome + Brave, extension side-loaded, Layer 2+3 SSRF only, no persistent audit log, no default-CI real-Chromium E2E, no token rotation, no `@koi/cli` touch.

### Phase 2 (follow-up issues — one per bullet, not a mega-PR)

1. **Layer 1 SSRF interception** (`Fetch.requestPaused` + DNS pinning + subresource filtering + tests).
2. **Windows support**: `%APPDATA%/Local/Koi/ChromeNativeHost/`, registry via `reg add`, Windows-specific liveness check.
3. **All Chromium variants**: Edge, Arc, Chromium, Vivaldi, Opera — validate + CI.
4. **Persistent audit log** (rolling NDJSON).
5. **Real-Chromium E2E automation** in default CI (`launchPersistentContext`).
6. **Idle-resume test** promoted from opt-in to default gate.
7. **Sidebar panel** + tab picker + persistent per-origin allowlist in `chrome.storage.sync`.
8. **`@koi/cli` subcommand proxy** (thin delegation to bin).
9. **`rotate-token` command**.
10. **`@koi/scopes` / ReBAC integration**.
11. **Chrome Web Store listing** — pin Web Store extension ID alongside the dev ID in `allowed_origins`.

## 12. Out of scope (deferred or declined)

- Firefox (different extension APIs — `browser.debugger` does not exist).
- Safari (Xcode signing + native app shell burden).
- MCP-style tool bridge (Koi uses `BrowserDriver` directly — no MCP indirection).
- mTLS / encrypted socket.
- Remote (cross-machine) sessions.

## 13. Open questions / follow-ups

- Extension ID (resolved — see §7.1): Phase 1 uses a split key regime. Dev key at `extension/keys/dev.pem` is committed and produces a known dev extension ID for development/testing; dev host `allowed_origins` lists only that dev ID. The production extension key is NOT committed — Phase 2 generates it during the first release-gate step, stores it in a CI secret / release keychain, and hardcodes the resulting production ID into `install.ts` release builds. Web Store release later adds the Google-signed ID alongside the production ID in `allowed_origins`.
- Bun host runtime (resolved — see §6.6): Phase 1 pins the native host to **Node.js only**. Driver and CLI remain Bun. Bun-as-host promoted to a Phase 2 investigation with explicit macOS/Linux NM framing acceptance tests.
- Max frame size (resolved — see §6.4): chunking is part of the wire protocol via the unified `chunk` frame envelope (§6.1). `correlationId` = `"r:${id}"` for results, `"e:${uuid}"` for events; reassembly keyed by `(sessionId, correlationId)`. Screenshot ≥1 MB path validated in `extension-sim.integration.test.ts` + `chunk-crash.integration.test.ts`.

## 14. Reference material

- Issue: https://github.com/windoliver/koi/issues/1609
- Claude Code `claudeInChrome` (2,089 LOC reference implementation):
  `/Users/sophiawj/private/claude-code-source-code/src/utils/claudeInChrome/`
  — `chromeNativeHost.ts`, `common.ts`, `setup.ts`, `setupPortable.ts`, `mcpServer.ts`, `prompt.ts`.
- v1 `@koi/browser-playwright` (port source):
  `/Users/sophiawj/private/koi/archive/v1/packages/drivers/browser-playwright/`
- v2 `BrowserDriver` contract: `packages/kernel/core/src/browser-driver.ts`.
- v1 `browser-playwright` docs (structure reference): `docs/L2/browser-playwright.md`.
