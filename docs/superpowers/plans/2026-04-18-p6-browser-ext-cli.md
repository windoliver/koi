# P6 — `@koi/browser-ext` CLI (install / uninstall / status) Implementation Plan

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Build the user-facing CLI that installs the Koi native-messaging manifest per Chromium browser, generates `installId` + `token` + `admin.key` + the host wrapper script with an absolute Node path baked in, unpacks the extension bundle, and revokes everything on `uninstall` via the `admin_clear_grants` path.

**Architecture:** Single bin entry at `packages/drivers/browser-ext/src/bin/koi-browser-ext.ts`. Three subcommands: `install`, `uninstall`, `status`. No dependency on a TUI framework — straight `process.stdout.write` + colorized via `picocolors`-style ANSI. Reuses the admin-role `hello` path from P3/P5 for online uninstall. **Offline uninstall is NOT supported in Phase 1** (per spec §8.7) — if the extension is unreachable, `uninstall` aborts with guidance and a non-zero exit.

**Tech stack:** Bun runtime (the CLI is `bunx`-invoked). `child_process.execFileSync` for `node --version` detection. Uses `@koi/browser-ext/native-host/install` (this plan adds it) to factor out NM manifest writing.

**Spec reference:** §6.6 (Node-runtime install-time detection + baked absolute path), §7.1 (allowed_origins → dev extension ID), §7.2 (token + admin.key files), §8.7 (uninstall flow + online-only + error text).

**Stacking:** Depends on P3 + P4 (extension bundle built into `dist/extension/`) + P5 (for the admin-role hello path in online uninstall). Branch: `p6-browser-ext-cli` off P5's HEAD.

---

## File structure

```
packages/drivers/browser-ext/
  src/
    native-host/
      install.ts                                    ← NM manifest + wrapper writer (shared with Task 1 below)
      browsers.ts                                   ← Chromium browser config table
    bin/
      koi-browser-ext.ts                            ← bin entry; top-level CLI dispatcher
    cli/
      install-command.ts
      uninstall-command.ts
      status-command.ts
    __tests__/
      native-host/
        install.test.ts
        browsers.test.ts
      cli/
        install-command.test.ts
        uninstall-command.test.ts
        status-command.test.ts
      __integration__/
        install-e2e.integration.test.ts            ← real bun subprocess; FS assertions
```

Update `package.json`: add `"bin": { "koi-browser-ext": "./dist/bin/koi-browser-ext.js" }` and add the bin entry to the tsup `entry` map. Add dep `picocolors` (if not already in monorepo — check existing CLIs first).

Also modify `docs/L2/browser-ext.md` with a CLI reference section (install, uninstall, status command docs).

---

## Tasks

### Task 1: `browsers.ts` — Chromium browser config table

Per spec §8.1 + claudeInChrome's `common.ts`. Phase 1 scope: Chrome + Brave. macOS + Linux. Table structure supports Windows (Phase 2) and other Chromium variants (Phase 2) with empty values for now.

```typescript
export interface BrowserConfig {
  readonly name: string;            // display name
  readonly macos: { readonly nativeMessagingPath: readonly string[]; readonly dataPath: readonly string[] };
  readonly linux: { readonly nativeMessagingPath: readonly string[]; readonly binaries: readonly string[] };
  readonly windows?: { readonly registryKey: string; readonly dataPath: readonly string[] };
}

export const CHROMIUM_BROWSERS: Readonly<Record<string, BrowserConfig>> = {
  chrome: { /* Google Chrome paths */ },
  brave: { /* Brave paths */ },
};

export function getAllNativeMessagingHostsDirs(): readonly { readonly browser: string; readonly path: string }[];
```

- [ ] Test-first. Assert the 4 paths produced on macOS + Linux match claudeInChrome's verified paths (reference: `/Users/sophiawj/private/claude-code-source-code/src/utils/claudeInChrome/common.ts`).

- [ ] Commit: `feat(browser-ext): Chromium browsers config table (Chrome + Brave; Phase 2 placeholders for others)`.

### Task 2: `install.ts` — NM manifest writer + wrapper script

Responsibilities:
- `installNativeHost({ browsers, extensionIds, installId, nodeAbsPath, manifestHostName })`:
  1. Resolve Node absolute path via `which node` + version check ≥ 20.11.
  2. Write wrapper script at `~/.koi/browser-ext/bin/native-host` (mode 0o755). Content: `#!/bin/sh\nexec "${nodeAbsPath}" "/Users/.../browser-ext/dist/native-host/index.js" "$@"\n`.
  3. For each browser's `nativeMessagingPath`, write `com.koi.browser_ext.json` with `{ name, description, path: <wrapper>, type: "stdio", allowed_origins: [<extensionIds>] }`.
  4. Return `{ manifestsWritten: string[], wrapper: string }`.

- `readInstalledManifests()`: scan each browser's dir, return any existing Koi manifests.

- `uninstallNativeHost({ manifestsRemoved })`: symmetric unlink.

- [ ] Test-first. Mock FS via `memfs`. Covers: fresh install writes everything; re-install is idempotent (same content → skip); Node < 20.11 → fails hard; Node missing → fails hard with instruction text.

- [ ] Commit: `feat(browser-ext): install.ts (NM manifest + wrapper with absolute Node path baked in)`.

### Task 3: `install-command.ts`

Orchestrates install:
1. Check Node ≥ 20.11; fail hard otherwise with error block exactly matching spec §8.1.
2. Generate `installId` (new each run, per spec §8.7 — any prior value is overwritten, triggering the wipe handshake on next extension boot).
3. Generate `token` + `admin.key` (32-byte random each, mode `0o600`).
4. Detect installed browsers via `browsers.ts`; write NM manifests + wrapper.
5. Unpack extension bundle: copy `dist/extension/` → `~/.koi/browser-ext/extension/`.
6. Print the "Next step" block instructing the user to load-unpacked.

- [ ] Test-first. Happy path. Mocks chrome detection + FS.

- [ ] Commit: `feat(browser-ext): install command (detect node, write manifests, unpack extension)`.

### Task 4: `uninstall-command.ts` — online-only

Per §8.7:
1. Try to connect to a live host via the discovery mechanism (P3/P5).
2. If no host found → abort with the exact error text from §8.7; exit 1.
3. Connect with admin role (`hello` with `admin.adminKey`).
4. Send `admin_clear_grants { scope: "all" }`; await ack.
5. Remove NM manifests per browser.
6. Remove `~/.koi/browser-ext/` (except the extension dir; leave that for user to remove manually via chrome://extensions).

- [ ] Test-first. Happy path (live host, admin-role hello, clear succeeds). Offline path (no host → abort). Unauthorized (admin.key missing) → specific error.

- [ ] Commit: `feat(browser-ext): uninstall command (online-only per §8.7; admin_clear_grants)`.

### Task 5: `status-command.ts`

Read + display current state: installId, browsers with manifest present/missing, token/admin.key file modes, live host (if any) with `{instanceId, pid, epoch, seq, extensionVersion}`, Node version check.

- [ ] Test-first.

- [ ] Commit: `feat(browser-ext): status command`.

### Task 6: `bin/koi-browser-ext.ts`

Thin dispatcher: parse `process.argv[2]` → invoke one of the three command functions. Print usage on no-args / `--help`.

- [ ] Add `bin` entry to package.json and add `"bin/koi-browser-ext": "src/bin/koi-browser-ext.ts"` to tsup entries.

- [ ] Commit: `feat(browser-ext): bin entry + CLI dispatcher`.

### Task 7: `install-e2e.integration.test.ts`

Run `bunx packages/drivers/browser-ext/dist/bin/koi-browser-ext.js install --dev` in a temp HOME. Assert manifests written, wrapper script content includes the absolute path to the Node binary resolved at install time. Then `uninstall` aborts (no live host in test env) — assert exit 1 + correct stderr.

- [ ] Commit: `test(browser-ext): install CLI e2e`.

### Task 8: Final gate + PR

- [ ] PR title: `feat(browser-ext): CLI install/uninstall/status (P6 of #1609)`.
