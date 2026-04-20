import { describe, expect, test } from "bun:test";

import { getBrowserInstallTargets, getNativeMessagingManifestPath } from "../browsers.js";

describe("browsers", () => {
  test("builds the expected macOS native messaging host paths", () => {
    const targets = getBrowserInstallTargets("darwin", "/Users/tester");
    expect(targets.map((target) => target.nativeMessagingHostsDir)).toEqual([
      "/Users/tester/Library/Application Support/Google/Chrome/NativeMessagingHosts",
      "/Users/tester/Library/Application Support/Microsoft Edge/NativeMessagingHosts",
      "/Users/tester/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
      "/Users/tester/Library/Application Support/Chromium/NativeMessagingHosts",
      "/Users/tester/Library/Application Support/Arc/NativeMessagingHosts",
    ]);
  });

  test("builds the expected Linux native messaging host paths", () => {
    const targets = getBrowserInstallTargets("linux", "/home/tester");
    expect(targets.map((target) => target.nativeMessagingHostsDir)).toEqual([
      "/home/tester/.config/google-chrome/NativeMessagingHosts",
      "/home/tester/.config/microsoft-edge/NativeMessagingHosts",
      "/home/tester/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
      "/home/tester/.config/chromium/NativeMessagingHosts",
      "/home/tester/.config/Arc/NativeMessagingHosts",
    ]);
  });

  test("computes the manifest filename per browser target", () => {
    const [target] = getBrowserInstallTargets("linux", "/home/tester");
    expect(target).toBeDefined();
    if (target === undefined) {
      return;
    }
    expect(getNativeMessagingManifestPath(target)).toBe(
      "/home/tester/.config/google-chrome/NativeMessagingHosts/com.koi.browser_ext.json",
    );
  });
});
