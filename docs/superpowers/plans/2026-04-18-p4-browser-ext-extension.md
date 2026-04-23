# P4 — `@koi/browser-ext` MV3 Service Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the Manifest V3 browser extension half of `@koi/browser-ext`: the service worker that talks CDP to attached Chrome tabs, bridges traffic through Chrome native messaging to the Koi host (P3), and enforces every extension-side invariant from the spec — private-origin gate, attach FSM, consent grants, `installId` handshake, `cleanup_pending` fencing, dual keepalive, chunking.

**Architecture:** Extension code lives at `packages/drivers/browser-ext/extension/`. Built with esbuild to `dist/extension/` for load-unpacked install. Imports zod schemas from `src/native-host/*` (which are Node-free) to share wire types with the host. The host ↔ extension protocol is the exact `NmFrame` schema from P3. Runs entirely in MV3 service-worker context — no Node APIs, no filesystem, no `require`; only `chrome.*` and standard browser globals.

**Tech Stack:** TypeScript 6 strict targeting `ES2022` with `chrome.*` types from `@types/chrome`. Bundler: esbuild (a new devDep in this package). Tests: `bun:test` with a `chrome.*` API stub module (roll our own — it's simpler than adopting `jest-chrome`). Real-Chromium integration test via Playwright's `launchPersistentContext({ args: ["--disable-extensions-except=…", "--load-extension=…"] })`.

**Spec reference:** `docs/superpowers/specs/2026-04-18-issue-1609-browser-ext-design.md` §6.5 (control frames), §7.3 (consent overview), §7.4 Layer 2 (private-origin), §8.3 (lifecycle), §8.4 (MV3 keepalive), §8.6 (attach FSM on extension), §8.7 (uninstall / admin_clear_grants).

**Stacking:** Independent of P1/P2. Depends on P3 for the wire schemas (will import from `packages/drivers/browser-ext/src/native-host/{driver-frame,nm-frame,control-frames}.ts`). Branch: `p4-browser-ext-extension` off P3's HEAD (after P3 PR opens).

---

## File structure

Files this plan creates:

```
packages/drivers/browser-ext/
  extension/
    manifest.json                                         ← MV3 manifest + pinned dev ID via `key`
    keys/
      dev.pem                                             ← dev extension signing key (committed — prod key stays out-of-tree, P2 of spec §7.1)
      dev.pub.b64                                         ← base64 of the public key (goes into manifest.json.key)
    src/
      service-worker.ts                                   ← main entry; wired in manifest
      storage.ts                                          ← typed wrappers for chrome.storage.{local,session}
      connect-native.ts                                   ← single-flight NM port + extension_hello emit + host_hello handling + installId wipe
      attach-fsm.ts                                       ← per-tab state machine (idle / pending_consent / attaching / attached)
      cleanup-pending.ts                                  ← cleanup_pending fence map (§8.5 for in-flight attach during port disconnect)
      consent.ts                                          ← prompt UI (chrome.notifications) + allow_once/always writes
      private-origin.ts                                   ← Layer 2 blocklist + frameNavigated handler
      document-id.ts                                      ← chrome.webNavigation.getAllFrames-based documentId capture
      keepalive.ts                                        ← chrome.alarms + port activity; keeps SW alive
      chunking.ts                                         ← send + receive halves of §6.4 protocol
      router.ts                                           ← NM-frame dispatcher: direction validation + route to fsm/cleanup/chunking/admin
      probe-responder.ts                                  ← handles attach_state_probe (chrome.debugger.getTargets)
      admin-responder.ts                                  ← handles admin_clear_grants (wipe storage + detach covered tabs)
      detach-helpers.ts                                   ← chrome.debugger.detach wrappers + emit detached NM frame
      options.html                                        ← options page for managing grants + allowlist + instance name label
      options.ts                                          ← options page logic
      build.ts                                            ← esbuild entry: service-worker + options → dist/extension/
      __tests__/
        (unit tests per module, same pattern as P3 but with mocked chrome.* APIs)
        __integration__/
          idle-resume.integration.test.ts                 ← real Chromium via launchPersistentContext, 90s idle window
          uninstall-reinstall-revocation.integration.test.ts ← installId mismatch wipe
```

Files this plan modifies:

```
packages/drivers/browser-ext/package.json                 ← add devDeps: @types/chrome, esbuild; add build:extension script
packages/drivers/browser-ext/tsconfig.json                ← ensure extension/ is in rootDir scope OR uses its own tsconfig
docs/L2/browser-ext.md                                    ← expand with extension architecture
```

**Out of scope for P4:**
- Driver side (P5).
- CLI install/uninstall (P6).
- Runtime wiring (P7).
- Layer 1 SSRF interception (`Fetch.requestPaused` + DNS pinning) — explicit Phase 2 non-goal.
- Tab-picker UI / sidebar panel — Phase 2.

---

## Task 1: Extension scaffold + Manifest V3 + esbuild

**Files:** Create `extension/manifest.json`, `extension/keys/`, `extension/build.ts`, `extension/src/service-worker.ts` (placeholder), `extension/tsconfig.json`.

- [ ] **Step 1**: `mkdir -p packages/drivers/browser-ext/extension/src/__tests__/__integration__ packages/drivers/browser-ext/extension/keys`.

- [ ] **Step 2**: Generate the dev signing key (one-time):

```bash
openssl genrsa 2048 > packages/drivers/browser-ext/extension/keys/dev.pem
openssl rsa -in packages/drivers/browser-ext/extension/keys/dev.pem -pubout -outform DER 2>/dev/null | openssl base64 -A > packages/drivers/browser-ext/extension/keys/dev.pub.b64
```

Commit both files. (The `dev.pem` being committed is intentional per spec §7.1: dev key only derives the dev extension ID; production releases use an out-of-tree key.)

- [ ] **Step 3**: Compute the dev extension ID (Chrome derives it from `dev.pub.b64`). Use this helper:

```bash
node -e 'const crypto = require("crypto"); const pk = require("fs").readFileSync("packages/drivers/browser-ext/extension/keys/dev.pub.b64", "utf-8").trim(); const raw = Buffer.from(pk, "base64"); const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32); console.log(hash.replace(/[0-9]/g, (d) => String.fromCharCode(97 + parseInt(d))).replace(/[a-f]/g, (c) => c));'
```

(This yields a 32-char `[a-p]` string — Chrome's extension-ID alphabet.) Record it; the installer will need it in P6 to populate `allowed_origins` on the NM manifest.

- [ ] **Step 4**: Write `extension/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Koi Browser Extension (dev)",
  "version": "0.1.0",
  "description": "Koi agent bridge — attaches to your live Chrome via chrome.debugger and native messaging.",
  "key": "<paste contents of extension/keys/dev.pub.b64 here>",
  "permissions": [
    "debugger",
    "nativeMessaging",
    "tabs",
    "notifications",
    "alarms",
    "storage",
    "webNavigation"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "service-worker.js",
    "type": "module"
  },
  "options_page": "options.html",
  "action": {
    "default_title": "Koi",
    "default_popup": "popup.html"
  }
}
```

**Important**: `service_worker: "service-worker.js"` is the BUILT path (post-esbuild). `action.default_popup` is minimal for now (can skip or reference an empty HTML file — just a placeholder).

- [ ] **Step 5**: Write `extension/build.ts`:

```typescript
import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const EXTENSION_ROOT = new URL("./", import.meta.url).pathname;
const OUT_DIR = join(EXTENSION_ROOT, "../dist/extension");

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  // 1. Bundle service worker + options script.
  await build({
    entryPoints: {
      "service-worker": join(EXTENSION_ROOT, "src/service-worker.ts"),
      options: join(EXTENSION_ROOT, "src/options.ts"),
    },
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    outdir: OUT_DIR,
    sourcemap: true,
    logLevel: "info",
  });

  // 2. Inject dev key into manifest.json.
  const manifestSrc = await readFile(join(EXTENSION_ROOT, "manifest.json"), "utf-8");
  const pubKey = (await readFile(join(EXTENSION_ROOT, "keys/dev.pub.b64"), "utf-8")).trim();
  const manifest = manifestSrc.replace("<paste contents of extension/keys/dev.pub.b64 here>", pubKey);
  await writeFile(join(OUT_DIR, "manifest.json"), manifest);

  // 3. Copy HTML files.
  for (const name of ["options.html", "popup.html"]) {
    const src = join(EXTENSION_ROOT, "src", name);
    await copyFile(src, join(OUT_DIR, name)).catch(() => {
      // popup.html is optional in P4 — skip if missing.
    });
  }
  console.log(`[build] wrote ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 6**: Write placeholder `extension/src/service-worker.ts`:

```typescript
// Placeholder — real implementation in subsequent tasks.
export {};
```

- [ ] **Step 7**: Add devDeps + build script to `packages/drivers/browser-ext/package.json`:

```json
  "devDependencies": {
    "@types/chrome": "^0.0.280",
    "esbuild": "^0.24.0"
  },
  "scripts": {
    "build": "tsup",
    "build:extension": "bun extension/build.ts",
    ...existing scripts...
  }
```

- [ ] **Step 8**: `bun install`, then `bun run --cwd packages/drivers/browser-ext build:extension`. Expect `dist/extension/{service-worker.js, service-worker.js.map, options.js, manifest.json}` to be created. Empty service-worker.js is fine for now.

- [ ] **Step 9**: Commit: `feat(browser-ext): MV3 extension scaffold (manifest, build, dev signing key)`.

---

## Task 2: Typed storage wrappers — `storage.ts`

Typed access to `chrome.storage.{local,session}` for: `installId`, `browserSessionId`, `alwaysGrants`, `allowOnceGrants`, `privateOriginAllowlist`, `extensionName`.

Write the module with explicit schemas + validators; unit-test each getter/setter.

- [ ] Test-first. Mocks `chrome.storage.{local,session}` with an in-memory Map. Asserts type narrowing works: reading a wrong-shape value returns the default + logs.

- [ ] Implement with zod schemas for each stored shape. Wrap `chrome.storage.local.get` / `.set` with Promises (they are async by default in MV3).

- [ ] Commit: `feat(browser-ext): typed chrome.storage wrappers`.

---

## Task 3: NM connection + `extension_hello` + `installId` wipe

**File:** `extension/src/connect-native.ts` + `extension/src/keepalive.ts` (part — single-flight guard lives here).

Responsibilities:
- `ensureConnected()` with the single-flight guard described in §8.3 (ConnState = idle | connecting | connected).
- Construct + send `extension_hello` with `{ instanceId, browserSessionId, browserHint, name, epoch, seq }` pulled from `storage`.
- Handle `host_hello`: on `installId` mismatch vs stored `koi.installId`, wipe every persisted grant (allowOnceGrants, alwaysGrants, privateOriginAllowlist) BEFORE marking the port `ready`. Write the new installId to storage. Block any queued attach traffic during wipe.
- Expose `portReady: boolean`; queue inbound attach-side frames until ready.
- `port.onDisconnect` handler: iterate every `attached`/`cleanup_pending` tab → detach (respecting the cleanup_pending rules from Task 5), then reconnect with 1s backoff.

Tests: mock `chrome.runtime.connectNative` + `port.postMessage`/`onMessage` + storage. Assert:
- First connect sends `extension_hello` with all fields.
- Mismatched installId → storage wipe happens BEFORE `portReady = true`.
- Matching installId → no wipe, `portReady = true` immediately.
- Two concurrent `ensureConnected()` calls during SW boot → only one `connectNative` invocation.
- Disconnect handler fires chrome.debugger.detach per attached tab (use spy); reconnect fires after 1s.

Commit: `feat(browser-ext): NM connect-native with single-flight + installId revocation handshake`.

---

## Task 4: Attach FSM — `attach-fsm.ts`

Per spec §8.6. Four phases: `idle`, `pending_consent`, `attaching`, `attached`. Participants list, unified terminal paths (every path replies to every participant exactly once), documentId binding (captured via `chrome.webNavigation.getAllFrames`).

Isolate from the private-origin gate (that's Task 6); attach-fsm calls into private-origin and consent.

- [ ] Test-first. Mocks chrome.debugger.attach / webNavigation / notifications. Covers:
  - Idle → pending_consent (no grant) → prompt → Allow once → attaching → attached; `allow_once` grant keyed by `(tabId, documentId)` written to storage.session.
  - Idle → attaching directly when `always` grant covers origin.
  - Two same-client requests while pending_consent → both appended to participants; both replied with success on attach.
  - Different-client second request — DOES NOT REACH THE FSM (host short-circuits per §8.5 rule 1). Sanity test: if it ever did, fsm should treat it as protocol violation.
  - Tab navigates during pending_consent (documentId changes) → discard consent, all participants fail `user_denied`.
  - `reattach: "consent_required_if_missing"` with no grant → immediate `consent_required` reply from idle, no prompt.
  - `reattach: "prompt_if_missing"` with no grant → prompt anyway.

- [ ] Implement.

- [ ] Commit: `feat(browser-ext): attach FSM (§8.6 participants + documentId + reattach policies)`.

---

## Task 5: `cleanup_pending` fence for port-disconnect during `attaching`

Per spec §8.4's "Extension cleanup on NM port disconnect" with the R8-round-7 refinement: `attaching` tabs keep a reference to their in-flight `chrome.debugger.attach` promise; port.onDisconnect does NOT clear the FSM state, instead moves to `cleanup_pending`; chains a continuation that detaches on late success; waiter queue for new attaches is held until the promise settles.

- [ ] Test-first. Use a controllable `chrome.debugger.attach` mock that the test drives.
  - Host-loss during `attaching`: FSM enters cleanup_pending; new attach on same tab is queued.
  - Late success → compensating detach fires, cleanup_pending cleared, queued new attach proceeds.
  - Late failure → cleanup_pending cleared, queued new attach proceeds.
  - 10s advisory force-detach fires but doesn't release the queue (queue held until promise settles).

- [ ] Implement.

- [ ] Commit: `feat(browser-ext): cleanup_pending fence for attaching-phase during port disconnect`.

---

## Task 6: Private-origin gate — `private-origin.ts`

Per §7.4 Layer 2. Runs BEFORE all consent/grant logic in the attach FSM. Private origins never write `allow_once` / `always` grants — only the separate `privateOriginAllowlist` store (written only via options page) can unlock them.

- [ ] Test-first:
  - `localhost:3000` → `attach_ack.reason: private_origin`; NO prompt fired.
  - `reattach: "prompt_if_missing"` for private origin → STILL `private_origin`, still no prompt.
  - Tab navigates to private origin mid-session → extension calls `chrome.debugger.detach`, emits `detached { reason: "private_origin" }` NM frame.
  - `always` consent click on public origin that later redirects to private origin → grant storage refuses to persist for the private origin.
  - Pre-populate `privateOriginAllowlist` with `http://localhost:3000` → attach succeeds normally.

- [ ] Implement: blocklist function + `chrome.webNavigation.onCommitted` handler for post-attach navigation check + grant-storage guard in `consent.ts` (Task 7) that rejects writes to blocked origins.

- [ ] Commit: `feat(browser-ext): private-origin gate (Layer 2, ahead of consent)`.

---

## Task 7: Consent prompt + `documentId` binding — `consent.ts` + `document-id.ts`

- [ ] Test-first:
  - `chrome.webNavigation.getAllFrames({ tabId })` yields main frame → `documentId` captured.
  - Prompt shown via `chrome.notifications.create`; buttons Allow once / Always / Deny.
  - Allow once writes `(tabId, documentId)` to `chrome.storage.session.allowOnceGrants`.
  - Always writes origin to `chrome.storage.local.alwaysGrants`; rejects if origin is in blocklist (sanity — the FSM gates before this, but consent.ts double-guards).
  - Deny returns `user_denied`; no storage writes.
  - 60s timeout returns `timeout`.
  - Navigation mid-prompt (documentId changes before user clicks) → consent discarded, `user_denied` returned.

- [ ] Implement.

- [ ] Commit: `feat(browser-ext): consent prompt + documentId binding + grant writes`.

---

## Task 8: `chrome.alarms` keepalive — `keepalive.ts`

Per §8.4.

- [ ] Test-first. Install alarm with `periodInMinutes: 0.5`. Alarm handler calls `ensureConnected()` (from Task 3). Test verifies alarm triggers `ensureConnected` call.

- [ ] Implement.

- [ ] Commit: `feat(browser-ext): MV3 keepalive (chrome.alarms fallback)`.

---

## Task 9: `attach_state_probe` responder — `probe-responder.ts`

Per §8.5 boot-time probe.

- [ ] Test-first:
  - On `attach_state_probe` NM frame, extension calls `chrome.debugger.getTargets()`, filters to tabs with an attached session not owned by this extension's in-memory state. Returns `attach_state_probe_ack { requestId, attachedTabs: [...] }`.
  - Tabs claimed locally but reported by getTargets as attached to someone else → extension force-detaches them (chrome.debugger.detach) before replying.

- [ ] Implement.

- [ ] Commit: `feat(browser-ext): attach_state_probe responder (crash-safe orphan reconciliation)`.

---

## Task 10: `admin_clear_grants` responder — `admin-responder.ts`

Per §8.7.

- [ ] Test-first:
  - Clear `chrome.storage.local.alwaysGrants` + `.privateOriginAllowlist` + `chrome.storage.session.allowOnceGrants`.
  - For each tab currently `attached`, emit NM `detached` + invoke detach helper (which itself calls `chrome.debugger.detach` + emits the detached frame once) — but the admin path uses a different `reason: "extension_reload"` or similar; plan to use `"unknown"` or add a new reason `"grant_revoked"` — pick `"unknown"` for P4 simplicity, note the limitation.
  - Reply `admin_clear_grants_ack { clearedOrigins, detachedTabs }`.

- [ ] Implement.

- [ ] Commit: `feat(browser-ext): admin_clear_grants responder (wipe grants + detach attached tabs)`.

---

## Task 11: Chunking — `chunking.ts`

Per §6.4. Send side (for CDP responses >1 MB): split into `chunk` frames with base64-encoded data, `correlationId` of `r:${id}` for results or `e:${uuid}` for events, `payloadKind` discriminator.

Receive side is technically symmetric but extensions rarely receive large CDP commands — still, implement for completeness.

- [ ] Test-first: 2 MB fake screenshot → sent as 3+ chunks; reassembly test (use the same reassembly logic as P3's Task 15; consider importing from `../src/native-host/chunk-reassembly.js` if the module has no Node deps — it doesn't, it's pure data manipulation).

- [ ] Implement. Share the reassembly module with native-host if feasible.

- [ ] Commit: `feat(browser-ext): chunking (send + receive halves)`.

---

## Task 12: Router — `router.ts`

The main NM message dispatcher. Validates direction (rejects frames that should only be host-originated arriving on our side — but all NM frames arriving at the extension ARE from the host, so this is a sanity check, not a security boundary). Routes by `kind` to the right handler.

- [ ] Test-first: stub each handler; assert correct handler invoked per frame kind.

- [ ] Implement.

- [ ] Commit: `feat(browser-ext): NM message router (direction validation + kind dispatch)`.

---

## Task 13: Service worker entry + final wiring — `service-worker.ts`

Replace the placeholder. Wire together:
1. On SW boot: atomic read-modify-write of `hostBootCounter` in storage.local → extract `epoch`. Seed in-memory `seq = 0`.
2. Ensure `browserSessionId` exists in storage.session; if missing, generate fresh UUID.
3. Install `chrome.alarms.create("koi-keepalive", { periodInMinutes: 0.5 })`.
4. Install event handlers: `chrome.runtime.onInstalled`, `chrome.alarms.onAlarm`, `chrome.tabs.onRemoved`, `chrome.webNavigation.onCommitted`.
5. Call `ensureConnected()` once to kick off the NM connection.
6. On every `chrome.runtime.Port.onMessage`, pass into router.
7. On every `chrome.runtime.Port.onDisconnect`, run the §8.4 normative cleanup handler (detach attached tabs, move attaching tabs to cleanup_pending).

- [ ] Test-first: drive a full boot via mocked chrome.*. Assert: first `ensureConnected` call; storage reads happen; alarm installed.

- [ ] Implement.

- [ ] Commit: `feat(browser-ext): service worker entry (SW boot orchestration)`.

---

## Task 14: `idle-resume.integration.test.ts` — real Chromium 90s

Per spec §10.3 + §8.4. **Gate: DEFAULT CI** (per spec, MV3 keepalive is production-critical and cannot regress silently).

- [ ] Test design:
  - `playwright.chromium.launchPersistentContext` with `--disable-extensions-except=<path>` + `--load-extension=<path>` pointing at `dist/extension/`.
  - Install a fake native-host shim (a Node subprocess) that accepts the NM frames and acts as P3's host.
  - Driver attaches tab 42 via the shim; wait 90s; call `browser.snapshot()`; assert success.
  - Verify SW is still alive via `chrome.management.getSelf` (through an injected content-script heartbeat).
  - Assert no `TRANSPORT_LOST` entries in the in-memory counter stream during the 90s window.

- [ ] Implement the shim + test.

- [ ] Commit: `test(browser-ext): idle-resume 90s integration (real Chromium, default CI)`.

---

## Task 15: `uninstall-reinstall-revocation.integration.test.ts`

Per spec §8.7 acceptance test.

- [ ] Test: setup always grants + privateOriginAllowlist in storage.local. Stop host. Change `~/.koi/browser-ext/installId`. Restart host with new installId. Extension's next `host_hello` receive → wipe runs → subsequent attach prompts fresh instead of auto-allowing.

- [ ] Commit: `test(browser-ext): uninstall-reinstall revocation integration`.

---

## Task 16: Register + docs + final gate

- [ ] **Step 1**: `@koi/browser-ext` already in L2_PACKAGES from P3. No change.

- [ ] **Step 2**: Expand `docs/L2/browser-ext.md` with extension architecture section — reference §8.6 FSM, §7.4 Layer 2, §8.4 keepalive, §8.7 admin revocation.

- [ ] **Step 3**: Full CI gate: `bun run typecheck && bun run lint && bun run check:layers && bun run test && bun run check:duplicates && bun run check:unused && bun run --cwd packages/drivers/browser-ext build:extension`.

- [ ] **Step 4**: Commit + open PR:
  - PR title: `feat(browser-ext): MV3 service worker (P4 of #1609)`.
  - Base: `main`. Head: `p4-browser-ext-extension`.
  - Body references spec §6.5 + §7 + §8.4 + §8.6; notes that driver (P5) + CLI installer (P6) + runtime wiring (P7) are pending.

---

## Review checklist

- [ ] **Spec coverage**: §6.5 (control frames) — Task 3. §7.3 (consent overview) — Task 7. §7.4 Layer 2 — Task 6. §8.3 (lifecycle: extension side) — Tasks 3, 13. §8.4 (MV3 keepalive) — Tasks 8, 13. §8.6 (attach FSM) — Tasks 4, 5. §8.7 (admin) — Task 10. §6.4 (chunking) — Task 11. Probe — Task 9. Idle-resume test in default CI — Task 14. Reinstall-revocation test — Task 15.
- [ ] **Deferred**: Driver (P5) + CLI installer with dev-key injection into NM `allowed_origins` (P6) + runtime wiring (P7) + Layer 1 SSRF (Phase 2) — all explicitly deferred.
- [ ] **Cross-package coupling**: schema modules imported from `../src/native-host/{driver-frame,nm-frame}.js` so the extension and the host agree at the type level. These modules have only zod as a dep (browser-safe), confirmed by P3.
- [ ] **Prod key**: dev key is committed; production key generation + its extension ID + `allowed_origins` entry is Phase 2. Noted in Task 1 Step 4's manifest comment.
- [ ] **Test runner**: `bun:test` for units; a Playwright-driven real-Chromium harness for two integration tests (idle-resume, uninstall-revocation).
