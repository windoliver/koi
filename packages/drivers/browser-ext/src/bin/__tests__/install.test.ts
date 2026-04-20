import { describe, expect, test } from "bun:test";

import { runInstallCommand } from "../install.js";

describe("runInstallCommand", () => {
  test("orchestrates node detection, auth generation, wrapper, manifests, and extension deploy", async () => {
    const calls: string[] = [];
    const result = await runInstallCommand(
      {
        homeDir: "/tmp/home",
        packageRoot: "/repo/packages/drivers/browser-ext",
        platform: "linux",
      },
      {
        detectNodeBinary: () => ({
          executablePath: "/opt/homebrew/bin/node",
          version: "v20.11.1",
          parsedVersion: { major: 20, minor: 11, patch: 1 },
        }),
        readLocalExtensionId: async () => "a".repeat(32),
        ensureExtensionBundle: async (dir) => {
          calls.push(`bundle:${dir}`);
        },
        generateInstallId: async (dir) => {
          calls.push(`installId:${dir}`);
          return "a".repeat(64);
        },
        generateAuthFiles: async (dir) => {
          calls.push(`auth:${dir}`);
          return {
            token: "t".repeat(64),
            adminKey: "a".repeat(64),
            tokenPath: `${dir}/token`,
            adminKeyPath: `${dir}/admin.key`,
          };
        },
        writeHostWrapper: async (wrapperPath, nodePath, hostEntrypointPath) => {
          calls.push(`wrapper:${wrapperPath}:${nodePath}:${hostEntrypointPath}`);
          return { path: wrapperPath, content: "", changed: true };
        },
        writeNativeMessagingManifests: async ({ targets, wrapperPath, allowedOrigins }) => {
          calls.push(`manifests:${targets.length}:${wrapperPath}:${allowedOrigins[0]}`);
          return targets.map((target) => ({
            browserId: target.browserId,
            browserName: target.browserName,
            path: `${target.nativeMessagingHostsDir}/com.koi.browser_ext.json`,
            changed: true,
          }));
        },
        copyExtensionBundle: async (from, to) => {
          calls.push(`copy:${from}:${to}`);
        },
      },
    );

    expect(result.installId).toBe("a".repeat(64));
    expect(result.wrapperPath).toBe("/tmp/home/.koi/browser-ext/bin/native-host");
    expect(result.manifestsWritten).toHaveLength(5);
    expect(calls).toEqual([
      "bundle:/repo/packages/drivers/browser-ext/dist/extension",
      "installId:/tmp/home/.koi/browser-ext",
      "auth:/tmp/home/.koi/browser-ext",
      "wrapper:/tmp/home/.koi/browser-ext/bin/native-host:/opt/homebrew/bin/node:/repo/packages/drivers/browser-ext/dist/native-host/index.js",
      `manifests:5:/tmp/home/.koi/browser-ext/bin/native-host:chrome-extension://${"a".repeat(32)}/`,
      "copy:/repo/packages/drivers/browser-ext/dist/extension:/tmp/home/.koi/browser-ext/extension",
    ]);
  });
});
