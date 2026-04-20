# P5 — `@koi/browser-ext` Driver Implementation Plan

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Build the Koi-facing driver half of `@koi/browser-ext`. Exposes `createExtensionBrowserDriver()` returning a `BrowserDriver` that discovers a live native host (P3), connects via Unix socket, stands up a local loopback WebSocket that Playwright speaks CDP over, and delegates all 20 driver methods to `@koi/browser-playwright` (P2) with `wsEndpoint` set to the local WS.

**Architecture:** L2 package extension; depends on `@koi/core`, `@koi/browser-playwright` (P2), `@koi/browser-a11y` (P1 — transitively). Driver code lives at `packages/drivers/browser-ext/src/`, sibling to `src/native-host/` (P3). No direct Playwright / chrome.debugger coupling — the driver only speaks `DriverFrame` over Unix socket.

**Tech stack:** Bun runtime on the driver side (unlike the host, which is Node — per spec §6.6). TypeScript 6 strict, `ws` for the loopback WebSocket server (new runtime dep).

**Spec reference:** §5.3 (public API), §8.3 (discovery), §8.5 (lease + ownership), §9 (error codes), §9.2 (auto-reconnect).

**Stacking:** Depends on P1 + P2 + P3. Branch: `p5-browser-ext-driver` off P3's HEAD once P3 exists.

---

## File structure

```
packages/drivers/browser-ext/
  src/
    driver.ts                                   ← createExtensionBrowserDriver
    unix-socket-transport.ts                    ← local WS server ↔ Unix socket
    discovery-client.ts                         ← scan instances/<pid>.json + select by HostSelector
    connection.ts                               ← hello/hello_ack, token + leaseToken pinning
    reconnect.ts                                ← auto-reconnect loop + reattach policy enforcement
    chunk-receive.ts                            ← reassembly (reuses reassembly-core from shared)
    errors.ts                                   ← 7 new KoiError codes + error-translator
    index.ts                                    ← public API
    __tests__/
      driver.test.ts
      unix-socket-transport.test.ts
      discovery-client.test.ts
      connection.test.ts
      reconnect.test.ts
      errors.test.ts
      api-surface.test.ts
      __integration__/
        driver-host.integration.test.ts         ← real host subprocess + fake extension
        ws-bridge.integration.test.ts           ← Playwright.connectOverCDP against our WS server
```

Update `package.json`: add runtime deps `@koi/browser-playwright`, `@koi/browser-a11y`, `playwright`, `ws`. Add devDep `@types/ws`.

---

## Tasks

### Task 1: Dep update + scaffold shared `chunk-reassembly-core.ts`

- [ ] Add `@koi/browser-playwright: workspace:*`, `@koi/browser-a11y: workspace:*`, `playwright: ^1.49.0`, `ws: ^8.18.0` to `packages/drivers/browser-ext/package.json` dependencies. Add `@types/ws: ^8.5.12` to devDeps.
- [ ] Refactor P3's `src/native-host/chunk-reassembly.ts` — move the core reassembly logic to `src/shared/chunk-reassembly-core.ts` (pure, zod-only, no Node APIs). Both `native-host/` and this task's driver can now import it.
- [ ] Commit: `refactor(browser-ext): extract chunk-reassembly-core to shared/ for driver reuse`.

### Task 2: `discovery-client.ts` — scan `instances/` + select host

- [ ] Test-first. Mock `fs.readdir` + `process.kill(pid, 0)`. Covers:
  - Single live host → selected automatically.
  - Two live hosts with different `instanceId` → `HOST_AMBIGUOUS` with `alternatives`.
  - Two live hosts with same `instanceId` but different `(epoch, seq)` → highest wins.
  - Dead-pid files auto-unlinked during scan.
  - `select.instanceId` narrows; `select.pid` narrows; `select.name` narrows (fails if ambiguous).
  - Retry on `ECONNREFUSED` — up to 3 retries with backoff; unlink the file only after dead-pid confirmation.

- [ ] Implement.

- [ ] Commit: `feat(browser-ext): discovery client (scan + select + stale-file GC)`.

### Task 3: `connection.ts` — hello handshake + leaseToken pinning

- [ ] Test-first. Mocks Unix socket client. Covers:
  - Successful hello → `hello_ack.ok=true role=driver`, selectedProtocol = 1.
  - Bad token → `hello_ack.ok=false reason=bad_token`.
  - Admin path (with `admin.adminKey`) → `role: admin`.
  - Protocol mismatch → `version_mismatch`.
  - Subsequent `attach` with different `leaseToken` from the one pinned in hello → host closes socket (this is host-side behavior from P3; verify driver handles the disconnect properly).

- [ ] Implement: `Connection` class that owns the socket + incoming-frame stream + outgoing writer.

- [ ] Commit: `feat(browser-ext): driver connection + hello handshake`.

### Task 4: `unix-socket-transport.ts` — local WS server bridging to Unix socket

This is the key mechanical piece. Playwright's `chromium.connectOverCDP({ wsEndpoint })` expects a ws://127.0.0.1:<port>/... endpoint. We stand up a local `ws.Server` bound to `127.0.0.1:0` (kernel-assigned port) that, for every incoming WS connection, pipes frames to/from the active Unix socket `cdp` channel.

- [ ] Test-first:
  - WS upgrade requires `Authorization: Bearer <token>` header; 401 otherwise.
  - Sending a CDP request via the WS → observed as `cdp` frame on the Unix socket.
  - `cdp_result` on Unix socket → sent back on the WS.
  - Closing the WS server cleanly unbinds.

- [ ] Implement using `ws.Server`. Multiplex: only one WS connection accepted at a time (Playwright opens one); if a second connects, reject with 1008.

- [ ] Commit: `feat(browser-ext): unix-socket-transport (local WS bridge for Playwright.connectOverCDP)`.

### Task 5: `driver.ts` — `createExtensionBrowserDriver` factory

Composes everything: discovery → connection → unix-socket-transport (start WS server) → `createPlaywrightBrowserDriver({ wsEndpoint: "ws://127.0.0.1:<port>", authToken })` → return the playwright driver, wrapped to surface browser-ext error codes via `errors.ts` translator.

- [ ] Test-first. Integration-style unit test with a mock native host + mocked Playwright:
  - Happy path: discover, connect, WS bridge up, Playwright driver works.
  - No live host → `HOST_SPAWN_FAILED`.
  - Multiple live hosts without `select` → `HOST_AMBIGUOUS`.
  - Missing token file → specific error.

- [ ] Implement.

- [ ] Commit: `feat(browser-ext): createExtensionBrowserDriver factory`.

### Task 6: `reconnect.ts` — auto-reconnect + `reattach` policy

- [ ] Per §9.2: backoff 100ms, 400ms, 1.6s, 6.4s, 25s × 5 attempts. On success: active sessions flagged invalid (caller must re-snapshot / re-attach). Auto-reconnect uses `reattach: "consent_required_if_missing"` by default; `reattachPolicy: "prompt_if_missing"` in the driver options overrides. `onReattach({ tabId, origin })` callback is invoked per re-attach and returns the policy for that specific call.

- [ ] Test-first. Controllable mock socket (test harness closes socket → driver detects → reconnect fires with backoff). Covers both policies + onReattach override.

- [ ] Implement.

- [ ] Commit: `feat(browser-ext): auto-reconnect loop + reattach policy (driver API exposed)`.

### Task 7: `errors.ts` — new `KoiError` codes

Per §9.1: `EXT_NOT_INSTALLED`, `EXT_WRONG_VERSION`, `EXT_USER_DENIED`, `TRANSPORT_LOST`, `HOST_SPAWN_FAILED`, `HOST_AMBIGUOUS`, `REATTACH_REQUIRES_CONSENT`. Plus an error-translator that maps `session_ended` reason → `PERMISSION` or `STALE_REF`.

- [ ] Test-first: table-driven mapping test.

- [ ] Implement.

- [ ] Commit: `feat(browser-ext): 7 new KoiError codes + session_ended → PERMISSION/STALE_REF translator`.

### Task 8: `index.ts` — public API + api-surface guard

Exports: `createExtensionBrowserDriver`, type `ReattachPolicy`, type `HostSelector`, type `ExtensionDriverConfig`.

Writes api-surface test pinning exactly those names.

- [ ] Commit: `feat(browser-ext): wire driver public API surface`.

### Task 9: Integration test — driver ↔ real host subprocess

- [ ] Spin up a real `@koi/browser-ext/native-host` subprocess (P3). Use a stubbed "extension" on the NM channel. Driver discovers host, connects, list_tabs returns a fake `[{ id: 42, url: "about:blank", title: "Test" }]`, attach tab 42, receive fake `attach_ack` with a synthesized `sessionId`. Verify the WS bridge is reachable and Playwright can `connectOverCDP` into it (even against a stubbed fake-CDP server).

- [ ] Commit: `test(browser-ext): driver-host integration (real subprocess, simulated extension)`.

### Task 10: Integration test — WS bridge with real Playwright

- [ ] Playwright's `chromium.connectOverCDP({ wsEndpoint })` points at our WS server. On the Unix socket side, simulate a Chrome that responds to `Target.getTargets` + `Page.navigate`. Assert Playwright gets back valid Page objects.

- [ ] Commit: `test(browser-ext): ws bridge with real Playwright connectOverCDP`.

### Task 11: Final CI gate + PR

- [ ] Full gate: typecheck, lint, check:layers (driver adds a new L2→L2 edge to browser-playwright — this is allowed and already expected; spec §5.2 notes the waiver), test, check:duplicates, check:unused.

- [ ] PR title: `feat(browser-ext): driver (P5 of #1609)`. Base main; head `p5-browser-ext-driver`. Body references P1/P2/P3 dependency chain.
