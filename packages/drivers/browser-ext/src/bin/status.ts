import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { listDiscoveryCandidates } from "../discovery-client.js";
import { readInstallId } from "../native-host/index.js";
import { statSecretFile } from "./auth-files.js";
import { getBrowserInstallTargets, type SupportedPlatform } from "./browsers.js";
import { readBakedHostEntrypointPath, readBakedNodePath } from "./host-wrapper.js";
import { readNativeMessagingManifests } from "./nm-manifest.js";
import { detectNodeBinary } from "./node-detect.js";

export interface StatusCommandResult {
  readonly installId: string | null;
  readonly liveHosts: readonly {
    readonly instanceId: string;
    readonly pid: number;
    readonly socket: string;
    readonly ready: boolean;
    readonly extensionVersion: string | null;
  }[];
  readonly manifests: readonly {
    readonly browserName: string;
    readonly present: boolean;
    readonly path: string;
  }[];
  readonly token: Awaited<ReturnType<typeof statSecretFile>>;
  readonly adminKey: Awaited<ReturnType<typeof statSecretFile>>;
  readonly node: {
    readonly status: "ok" | "error";
    readonly detail: string;
  };
}

export async function runStatusCommand(
  homeDir: string = homedir(),
  platform: SupportedPlatform = process.platform as SupportedPlatform,
): Promise<StatusCommandResult> {
  const baseDir = join(homeDir, ".koi", "browser-ext");
  const instancesDir = join(baseDir, "instances");
  const wrapperPath = join(baseDir, "bin", "native-host");
  const installId = await readInstallId(baseDir).catch(() => null);
  const liveHosts = (await listDiscoveryCandidates(instancesDir)).map((candidate) => ({
    instanceId: candidate.instanceId,
    pid: candidate.pid,
    socket: candidate.socket,
    ready: candidate.ready,
    extensionVersion: candidate.extensionVersion,
  }));
  const manifests = await readNativeMessagingManifests(getBrowserInstallTargets(platform, homeDir));
  const token = await statSecretFile(join(baseDir, "token"));
  const adminKey = await statSecretFile(join(baseDir, "admin.key"));

  const node = await (async () => {
    try {
      const detected = detectNodeBinary();
      const bakedPath = await readBakedNodePath(wrapperPath);
      if (bakedPath !== null) {
        await stat(bakedPath);
      }
      // Also validate the host JS entrypoint Chrome will execute via the
      // wrapper. Without this, status reports ok:true whenever Node exists
      // even if the wrapper's script target has been deleted (e.g. after a
      // cache eviction of a bunx install location).
      const entrypointPath = await readBakedHostEntrypointPath(wrapperPath);
      if (entrypointPath !== null) {
        await stat(entrypointPath);
      }
      return {
        status: "ok" as const,
        detail: `${detected.version} (${detected.executablePath})`,
      };
    } catch (error) {
      return {
        status: "error" as const,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  })();

  return {
    installId,
    liveHosts,
    manifests: manifests.map((manifest) => ({
      browserName: manifest.browserName,
      present: manifest.present,
      path: manifest.path,
    })),
    token,
    adminKey,
    node,
  };
}

export function formatStatusSummary(result: StatusCommandResult): string {
  const lines = [
    `Install ID: ${result.installId ?? "missing"}`,
    `Node: ${result.node.status} — ${result.node.detail}`,
    "Live hosts:",
  ];

  if (result.liveHosts.length === 0) {
    lines.push("  none");
  } else {
    for (const host of result.liveHosts) {
      lines.push(
        `  pid=${host.pid} ready=${host.ready} instanceId=${host.instanceId} socket=${host.socket} extension=${host.extensionVersion ?? "unknown"}`,
      );
    }
  }

  lines.push("Native messaging manifests:");
  for (const manifest of result.manifests) {
    lines.push(
      `  ${manifest.browserName}: ${manifest.present ? "present" : "missing"} (${manifest.path})`,
    );
  }

  lines.push(`token: ${result.token.present ? result.token.mode : "missing"}`);
  lines.push(`admin.key: ${result.adminKey.present ? result.adminKey.mode : "missing"}`);
  return lines.join("\n");
}
