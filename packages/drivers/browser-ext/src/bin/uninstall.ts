import { randomBytes } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { selectDiscoveryHost } from "../discovery-client.js";
import { readAdminKey, readToken } from "../native-host/index.js";
import type { DriverClient } from "../unix-socket-transport.js";
import { createDriverClient } from "../unix-socket-transport.js";
import { wipeAuthFiles } from "./auth-files.js";
import type { SupportedPlatform } from "./browsers.js";
import { getBrowserInstallTargets } from "./browsers.js";
import { removeNativeMessagingManifests } from "./nm-manifest.js";

export interface UninstallCommandOptions {
  readonly homeDir?: string;
  readonly platform?: SupportedPlatform;
}

export interface UninstallCommandResult {
  readonly clearedOrigins: readonly string[];
  readonly detachedTabs: readonly number[];
  readonly removedManifestPaths: readonly string[];
  readonly removedPaths: readonly string[];
  /**
   * True when the uninstall completed a live admin_clear_grants round-trip
   * with the extension. False when local artifacts were removed as a
   * best-effort cleanup because the extension/host was unreachable.
   */
  readonly onlineGrantClearanceCompleted: boolean;
}

export interface UninstallCommandDependencies {
  readonly selectDiscoveryHost?: typeof selectDiscoveryHost;
  readonly createDriverClient?: typeof createDriverClient;
  readonly readToken?: typeof readToken;
  readonly readAdminKey?: typeof readAdminKey;
  readonly getBrowserInstallTargets?: typeof getBrowserInstallTargets;
  readonly removeNativeMessagingManifests?: typeof removeNativeMessagingManifests;
  readonly wipeAuthFiles?: typeof wipeAuthFiles;
  readonly removeRuntimeFiles?: (baseDir: string) => Promise<readonly string[]>;
}

function offlineUninstallGuidance(): string {
  return [
    "Uninstall requires a live browser extension connection in Phase 1.",
    "Open Chrome (or your selected browser), make sure the Koi Browser Extension is enabled, then re-run `bunx @koi/browser-ext uninstall`.",
    "Run `bunx @koi/browser-ext status` to diagnose.",
  ].join("\n");
}

async function defaultRemoveRuntimeFiles(baseDir: string): Promise<readonly string[]> {
  const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const entry of entries) {
    // Remove everything including the deployed extension bundle. Leaving it
    // behind after uninstall is a leftover trust artifact; rollback must be
    // complete.
    const path = join(baseDir, entry.name);
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

async function removeLocalArtifacts(
  baseDir: string,
  platform: SupportedPlatform,
  homeDir: string,
  deps: UninstallCommandDependencies,
): Promise<{
  readonly removedManifestPaths: readonly string[];
  readonly removedPaths: readonly string[];
}> {
  const removedManifestPaths = await (
    deps.removeNativeMessagingManifests ?? removeNativeMessagingManifests
  )((deps.getBrowserInstallTargets ?? getBrowserInstallTargets)(platform, homeDir));
  await (deps.wipeAuthFiles ?? wipeAuthFiles)(baseDir);
  const removedPaths = await (deps.removeRuntimeFiles ?? defaultRemoveRuntimeFiles)(baseDir);
  return { removedManifestPaths, removedPaths };
}

function leaseToken(): string {
  return randomBytes(16).toString("hex");
}

export async function runUninstallCommand(
  options: UninstallCommandOptions = {},
  deps: UninstallCommandDependencies = {},
): Promise<UninstallCommandResult> {
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? (process.platform as SupportedPlatform);
  const baseDir = join(homeDir, ".koi", "browser-ext");
  const instancesDir = join(baseDir, "instances");

  // Grant revocation is the REAL trust-boundary removal: it tells the
  // extension to drop its stored consent + detach live tabs. Local artifacts
  // (NM manifests, token, admin.key) are the MECHANISM for revocation — if we
  // delete them without a successful clear, the user can never revoke grants
  // via this CLI again (the host needs the token to authenticate, the
  // manifests to route NM connections).
  //
  // Policy: fail closed on offline uninstall. Only remove local artifacts
  // AFTER admin_clear_grants succeeds. On failure, report the issue and
  // preserve state so the user can retry after bringing the extension online.
  let clearedOrigins: readonly string[] = [];
  let detachedTabs: readonly number[] = [];
  let onlineGrantClearanceCompleted = false;
  let failureReason: string | null = null;

  const selected = await (deps.selectDiscoveryHost ?? selectDiscoveryHost)({ instancesDir });
  if ("code" in selected) {
    failureReason = "no live browser-ext host discovered";
  } else {
    try {
      const token = await (deps.readToken ?? readToken)(baseDir);
      const adminKey = await (deps.readAdminKey ?? readAdminKey)(baseDir);
      const client: DriverClient = (deps.createDriverClient ?? createDriverClient)(selected.socket);
      await client.connect();
      try {
        const hello = await client.hello({
          kind: "hello",
          token,
          driverVersion: "0.0.0",
          supportedProtocols: [1],
          leaseToken: leaseToken(),
          admin: { adminKey },
        });
        if (hello.ok !== true) {
          failureReason = `admin hello failed: ${hello.reason}`;
        } else if (hello.role !== "admin") {
          failureReason = `admin hello returned unexpected role: ${hello.role}`;
        } else {
          const clearAck = await client.adminClearGrants({
            kind: "admin_clear_grants",
            scope: "all",
          });
          if (clearAck.ok === true) {
            clearedOrigins = clearAck.clearedOrigins;
            detachedTabs = clearAck.detachedTabs;
            onlineGrantClearanceCompleted = true;
          } else {
            failureReason = `admin_clear_grants failed: ${clearAck.reason}`;
          }
        }
      } finally {
        await client.close();
      }
    } catch (err) {
      failureReason = `admin handshake raised: ${(err as Error).message ?? String(err)}`;
    }
  }

  if (!onlineGrantClearanceCompleted) {
    // Fail closed: preserve the local credentials/manifests so the user can
    // retry revocation after bringing the extension online. Removing them now
    // would irreversibly strand extension-side grants.
    throw new Error(
      `${offlineUninstallGuidance()}\n\nUnderlying failure: ${failureReason ?? "unknown"}`,
    );
  }

  const { removedManifestPaths, removedPaths } = await removeLocalArtifacts(
    baseDir,
    platform,
    homeDir,
    deps,
  );

  return {
    clearedOrigins,
    detachedTabs,
    removedManifestPaths,
    removedPaths,
    onlineGrantClearanceCompleted,
  };
}

export function formatUninstallSummary(result: UninstallCommandResult): string {
  const lines = [
    `Cleared origins: ${result.clearedOrigins.length}`,
    `Detached tabs: ${result.detachedTabs.length}`,
    `Removed manifests: ${result.removedManifestPaths.length}`,
  ];
  if (!result.onlineGrantClearanceCompleted) {
    lines.push(
      "Note: extension was unreachable — local artifacts removed, but grant state inside the extension",
      "may still reflect the old install. Re-enable the extension and run `bunx @koi/browser-ext uninstall`",
      "again (or manually clear grants via the extension's options page) to complete revocation.",
    );
  }
  lines.push(
    "Extension still installed in browser — remove it via chrome://extensions if desired.",
  );
  return lines.join("\n");
}

/** Guidance text shown when offline uninstall cannot complete grant clearance. */
export function offlineUninstallNotice(): string {
  return offlineUninstallGuidance();
}
