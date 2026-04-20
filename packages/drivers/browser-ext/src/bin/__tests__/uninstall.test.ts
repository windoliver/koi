import { describe, expect, test } from "bun:test";

import { runUninstallCommand } from "../uninstall.js";

describe("runUninstallCommand", () => {
  test("clears grants online before removing manifests and auth files", async () => {
    const calls: string[] = [];
    const result = await runUninstallCommand(
      {
        homeDir: "/tmp/home",
        platform: "linux",
      },
      {
        selectDiscoveryHost: async () => ({
          instanceId: "11111111-1111-1111-1111-111111111111",
          pid: 123,
          socket: "/tmp/koi.sock",
          ready: true,
          name: "personal",
          browserHint: "Google Chrome",
          extensionVersion: "0.1.0",
          epoch: 1,
          seq: 1,
        }),
        readToken: async () => "t".repeat(64),
        readAdminKey: async () => "a".repeat(64),
        createDriverClient: (() => ({
          connect: async () => {
            calls.push("connect");
          },
          hello: async () => {
            calls.push("hello");
            return {
              kind: "hello_ack",
              ok: true,
              role: "admin",
              hostVersion: "0.1.0",
              extensionVersion: "0.1.0",
              wsEndpoint: "",
              selectedProtocol: 1,
            };
          },
          listTabs: async () => ({ kind: "tabs", tabs: [] }),
          adminClearGrants: async () => {
            calls.push("admin_clear_grants");
            return {
              kind: "admin_clear_grants_ack",
              ok: true,
              clearedOrigins: ["https://example.com"],
              detachedTabs: [42],
            };
          },
          attach: async () => ({
            kind: "attach_ack",
            ok: false,
            tabId: 1,
            leaseToken: "0".repeat(32),
            attachRequestId: "11111111-1111-4111-8111-111111111111",
            reason: "timeout",
          }),
          sendCdpFrame: async () => {},
          setFrameHandler: () => {},
          setCloseHandler: () => {},
          close: async () => {
            calls.push("close");
          },
        })) as never,
        removeNativeMessagingManifests: async (targets) => {
          calls.push(`rm-manifests:${targets.length}`);
          return targets.map(
            (target) => `${target.nativeMessagingHostsDir}/com.koi.browser_ext.json`,
          );
        },
        wipeAuthFiles: async () => {
          calls.push("wipe-auth");
        },
        removeRuntimeFiles: async () => {
          calls.push("rm-runtime");
          return ["/tmp/home/.koi/browser-ext/bin"];
        },
      },
    );

    expect(result.clearedOrigins).toEqual(["https://example.com"]);
    expect(calls).toEqual([
      "connect",
      "hello",
      "admin_clear_grants",
      "rm-manifests:5",
      "wipe-auth",
      "rm-runtime",
      "close",
    ]);
  });

  test("fails closed when no live host is reachable", async () => {
    await expect(
      runUninstallCommand(
        { homeDir: "/tmp/home" },
        {
          selectDiscoveryHost: async () =>
            ({
              code: "HOST_SPAWN_FAILED",
              message: "missing",
            }) as never,
        },
      ),
    ).rejects.toThrow(/requires a live browser extension connection/);
  });
});
