# @koi/browser-ext

L2 package. Extension-injected browser session driver + native messaging host.
Attaches to the user's live Chrome without `--remote-debugging-port`.

**Issue:** #1609.

## Package layout (P3 → P7 rollout)

| Subtree                                  | Phase  | Scope                                          |
| ---------------------------------------- | ------ | ---------------------------------------------- |
| `src/native-host/`                       | **P3** | Node.js subprocess: NM frames, schemas, auth, attach/detach coordinators, quarantine, boot probe, orchestrator. |
| `extension/`                             | P4     | MV3 service worker: attach FSM, consent grants, `installId` handshake, keepalive, chunking. |
| `src/driver.ts`, `src/unix-socket-transport.ts` | P5 | `createExtensionBrowserDriver()` + loopback WS bridge into `@koi/browser-playwright`. |
| `src/bin/koi-browser-ext.ts`             | P6     | `install` / `uninstall` / `status` CLI.        |
| Runtime wiring + golden queries          | P7     | Wire into `@koi/runtime`; add standalone golden coverage. |

## Spec

`docs/superpowers/specs/2026-04-18-issue-1609-browser-ext-design.md` (session
artifact — not in-tree). Protocol invariants: §6 wire protocol, §7 security,
§8.3 boot sequence, §8.5 attach lease + quarantine, §8.7 uninstall.

## Dependencies (Node.js ≥20.11)

- `@koi/core` — L0 types
- `zod` — wire-frame validation

The host runs under Node, not Bun: Chrome's native-messaging stdin framing
hasn't been validated with Bun's pipe handling (spec §6.6).

## Exports

### `@koi/browser-ext/native-host` (P3)

- `runNativeHost(config)` — orchestrator entry point. Implements §8.3 boot
  sequence strictly: install-id read → stdin `extension_hello` → `host_hello` →
  quarantine reseed → `attach_state_probe` → accept() → discovery file publish.
- `DriverFrameSchema` / `NmFrameSchema` / `NmControlFrameSchema` — zod schemas
  with direction predicates (`isDriverOriginated`, `isExtensionOriginated`, …).
- `createAttachCoordinator` / `createDetachCoordinator` — §8.5 state machines.
- `createQuarantineJournal` — per-instance durable quarantine with per-entry
  writer stamps + flock merge.
- `createChunkBuffer` — session-scoped reassembly keyed on
  `(sessionId, correlationId)` with `payloadKind` guard.
- `runBootProbe` — boot-time `attach_state_probe` responder.
- `generateInstallId` / `readInstallId` / `readToken` / `readAdminKey` /
  `validateHello` — auth primitives.
- `writeDiscoveryFile` / `scanInstances` / `supersedeStale` — per-host
  `instances/<pid>.json` lifecycle.

### `@koi/browser-ext`

- `createExtensionBrowserDriver(config)` — browser-driver transport that
  discovers a live native host, performs the hello/auth handshake, lists tabs,
  and manages attach/reconnect lifecycle for a selected tab.
- `createDriverClient(...)` / `createLoopbackWebSocketBridge(...)` — lower-level
  transport primitives used by the driver.

## Phase 1 scope

- Single spawn authority: extension only (host never spawns itself).
- `installId` handshake with grant revocation (spec §7).
- Per-request attach correlation — composite `(clientId, attachRequestId)` key.
- Document-id-bound consent (spec §8.6).
- Quarantine journal durability across host restarts.

## Extension architecture (P4)

- Manifest V3 service worker lives under `extension/src/service-worker.ts` and
  is bundled with esbuild into `dist/extension/` for Chrome "Load unpacked".
- Native messaging bridge is `chrome.runtime.connectNative()` plus the shared
  `NmFrame` / `NmControlFrame` schemas from `src/native-host/`.
- Attach lifecycle is enforced in the extension, not the host:
  `idle -> pending_consent -> attaching -> attached`, with
  `cleanup_pending` fencing during host-loss while `chrome.debugger.attach()`
  is still in flight.
- Consent is document-bound:
  `allow_once` lives in `chrome.storage.session` keyed by `(tabId, documentId)`;
  `always` lives in `chrome.storage.local` keyed by origin.
- Layer 2 private-origin enforcement happens before consent:
  blocked origins never prompt, never persist normal grants, and force a detach
  on navigation if a live session reaches a blocked origin.
- Reinstall revocation is extension-enforced on every `host_hello`:
  an `installId` mismatch wipes `always`, `allow_once`, and the private-origin
  allowlist before the NM port is marked ready.
- Keepalive is dual-path per spec §8.4:
  `chrome.alarms` wakes the worker every 30s, and the live NM port exchanges
  ping/pong control frames while connected.

## Current status (P7)

- P3 through P6 scope is now in-tree on this branch: native host, MV3
  extension, transport driver, and install/status/uninstall CLI are all
  implemented.
- P7 runtime integration is complete at the package boundary: `@koi/runtime`
  depends on `@koi/browser-ext`, and runtime golden coverage now asserts the
  public export surface plus browser-tool enumeration against the extension
  driver factory.
- The remaining verification item for this stacked branch is manual end-to-end
  smoke. That is intentionally human-run because the browser-ext transport is on
  this branch, while the `@koi/browser-playwright` backend it ultimately
  delegates to lives on a separate stacked PR from `main`.

## Manual E2E smoke checklist

1. Run `bunx @koi/browser-ext install`.
2. Open `chrome://extensions`, enable Developer mode, then load unpacked from
   `~/.koi/browser-ext/extension/`.
3. Start Koi with the extension driver configured via
   `createExtensionBrowserDriver(...)`.
4. Confirm the browser-ext driver can enumerate tabs and that `tabList()`
   returns the Chrome tab you expect to target.
5. Attach to that tab and approve the one-time consent prompt in Chrome if the
   extension asks for it.
6. Navigate the attached tab to `https://example.com`.
7. Capture a snapshot and confirm the returned accessibility-tree text reflects
   the Example Domain page.
8. Detach or end the session cleanly, then confirm the extension returns to its
   idle state.

## Notes

- `src/ws-shim.d.ts` import order is enforced by Biome (alphabetical). No runtime impact; cosmetic only.
