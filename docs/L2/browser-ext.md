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
| Runtime wiring + golden queries          | P7     | Wire into `@koi/runtime`; add cassette.        |

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

### `@koi/browser-ext` (placeholder until P5)

Driver entry lands in P5.

## Phase 1 scope

- Single spawn authority: extension only (host never spawns itself).
- `installId` handshake with grant revocation (spec §7).
- Per-request attach correlation — composite `(clientId, attachRequestId)` key.
- Document-id-bound consent (spec §8.6).
- Quarantine journal durability across host restarts.

## Known gaps (P3)

- Integration tests (real Node subprocess + simulated extension) deferred to a
  follow-up. Unit coverage for every module is in place.
- Driver-side (`@koi/browser-ext` root `index.ts`) + extension assets + CLI +
  runtime wiring all land in subsequent plans (P4–P7).
