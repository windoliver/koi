import { homedir } from "node:os";
import { join } from "node:path";

export type SupportedPlatform = "darwin" | "linux" | "win32";

interface BrowserPaths {
  readonly nativeMessagingHostsDir?: readonly string[];
  readonly dataDir?: readonly string[];
}

export interface BrowserConfig {
  readonly id: "chrome" | "edge" | "brave" | "chromium" | "arc";
  readonly name: string;
  readonly macos: BrowserPaths;
  readonly linux: BrowserPaths;
  readonly windows: BrowserPaths;
}

export interface BrowserInstallTarget {
  readonly browserId: BrowserConfig["id"];
  readonly browserName: string;
  readonly nativeMessagingHostsDir: string;
  readonly dataDir: string | null;
  readonly platform: SupportedPlatform;
}

export const NATIVE_HOST_MANIFEST_NAME = "com.koi.browser_ext.json";

export const CHROMIUM_BROWSERS: readonly BrowserConfig[] = [
  {
    id: "chrome",
    name: "Google Chrome",
    macos: {
      nativeMessagingHostsDir: [
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
      ],
      dataDir: ["Library", "Application Support", "Google", "Chrome"],
    },
    linux: {
      nativeMessagingHostsDir: [".config", "google-chrome", "NativeMessagingHosts"],
      dataDir: [".config", "google-chrome"],
    },
    windows: {},
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    macos: {
      nativeMessagingHostsDir: [
        "Library",
        "Application Support",
        "Microsoft Edge",
        "NativeMessagingHosts",
      ],
      dataDir: ["Library", "Application Support", "Microsoft Edge"],
    },
    linux: {
      nativeMessagingHostsDir: [".config", "microsoft-edge", "NativeMessagingHosts"],
      dataDir: [".config", "microsoft-edge"],
    },
    windows: {},
  },
  {
    id: "brave",
    name: "Brave",
    macos: {
      nativeMessagingHostsDir: [
        "Library",
        "Application Support",
        "BraveSoftware",
        "Brave-Browser",
        "NativeMessagingHosts",
      ],
      dataDir: ["Library", "Application Support", "BraveSoftware", "Brave-Browser"],
    },
    linux: {
      nativeMessagingHostsDir: [
        ".config",
        "BraveSoftware",
        "Brave-Browser",
        "NativeMessagingHosts",
      ],
      dataDir: [".config", "BraveSoftware", "Brave-Browser"],
    },
    windows: {},
  },
  {
    id: "chromium",
    name: "Chromium",
    macos: {
      nativeMessagingHostsDir: [
        "Library",
        "Application Support",
        "Chromium",
        "NativeMessagingHosts",
      ],
      dataDir: ["Library", "Application Support", "Chromium"],
    },
    linux: {
      nativeMessagingHostsDir: [".config", "chromium", "NativeMessagingHosts"],
      dataDir: [".config", "chromium"],
    },
    windows: {},
  },
  {
    id: "arc",
    name: "Arc",
    macos: {
      nativeMessagingHostsDir: ["Library", "Application Support", "Arc", "NativeMessagingHosts"],
      dataDir: ["Library", "Application Support", "Arc"],
    },
    linux: {
      nativeMessagingHostsDir: [".config", "Arc", "NativeMessagingHosts"],
      dataDir: [".config", "Arc"],
    },
    windows: {},
  },
] as const;

function platformPaths(
  browser: BrowserConfig,
  platform: SupportedPlatform,
): { readonly nativeMessagingHostsDir?: readonly string[]; readonly dataDir?: readonly string[] } {
  switch (platform) {
    case "darwin":
      return browser.macos;
    case "linux":
      return browser.linux;
    case "win32":
      return browser.windows;
  }
}

export function getBrowserInstallTargets(
  platform: SupportedPlatform = process.platform as SupportedPlatform,
  home: string = homedir(),
): readonly BrowserInstallTarget[] {
  return CHROMIUM_BROWSERS.flatMap((browser) => {
    const paths = platformPaths(browser, platform);
    if (paths.nativeMessagingHostsDir === undefined) {
      return [];
    }
    return [
      {
        browserId: browser.id,
        browserName: browser.name,
        nativeMessagingHostsDir: join(home, ...paths.nativeMessagingHostsDir),
        dataDir: paths.dataDir ? join(home, ...paths.dataDir) : null,
        platform,
      },
    ];
  });
}

export function getNativeMessagingManifestPath(target: BrowserInstallTarget): string {
  return join(target.nativeMessagingHostsDir, NATIVE_HOST_MANIFEST_NAME);
}
