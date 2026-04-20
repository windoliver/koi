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
    if (entry.name === "extension") {
      continue;
    }
    const path = join(baseDir, entry.name);
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
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

  const selected = await (deps.selectDiscoveryHost ?? selectDiscoveryHost)({ instancesDir });
  if ("code" in selected) {
    throw new Error(offlineUninstallGuidance());
  }

  const token = await (deps.readToken ?? readToken)(baseDir).catch((cause: unknown) => {
    throw new Error("Cannot uninstall without ~/.koi/browser-ext/token.", { cause });
  });
  const adminKey = await (deps.readAdminKey ?? readAdminKey)(baseDir).catch((cause: unknown) => {
    throw new Error("Cannot uninstall without ~/.koi/browser-ext/admin.key.", { cause });
  });

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

    if (hello.ok !== true || hello.role !== "admin") {
      throw new Error(
        `Admin hello failed: ${hello.ok ? `unexpected role ${hello.role}` : hello.reason}`,
      );
    }

    const clearAck = await client.adminClearGrants({
      kind: "admin_clear_grants",
      scope: "all",
    });

    if (clearAck.ok !== true) {
      throw new Error(
        clearAck.reason === "timeout"
          ? "Timed out waiting for admin_clear_grants_ack after 30s."
          : "Host rejected admin_clear_grants because this client is not authorized as admin.",
      );
    }

    const removedManifestPaths = await (
      deps.removeNativeMessagingManifests ?? removeNativeMessagingManifests
    )((deps.getBrowserInstallTargets ?? getBrowserInstallTargets)(platform, homeDir));
    await (deps.wipeAuthFiles ?? wipeAuthFiles)(baseDir);
    const removedPaths = await (deps.removeRuntimeFiles ?? defaultRemoveRuntimeFiles)(baseDir);

    return {
      clearedOrigins: clearAck.clearedOrigins,
      detachedTabs: clearAck.detachedTabs,
      removedManifestPaths,
      removedPaths,
    };
  } finally {
    await client.close();
  }
}

export function formatUninstallSummary(result: UninstallCommandResult): string {
  return [
    `Cleared origins: ${result.clearedOrigins.length}`,
    `Detached tabs: ${result.detachedTabs.length}`,
    `Removed manifests: ${result.removedManifestPaths.length}`,
    "Extension still installed — remove it via chrome://extensions if desired.",
  ].join("\n");
}
