import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { type BrowserInstallTarget, getNativeMessagingManifestPath } from "./browsers.js";

export const DEFAULT_MANIFEST_HOST_NAME = "com.koi.browser_ext";
export const DEFAULT_MANIFEST_DESCRIPTION = "Koi Browser Extension native messaging host";

export interface NativeMessagingManifest {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly type: "stdio";
  readonly allowed_origins: readonly string[];
}

export interface ManifestInstallResult {
  readonly browserId: BrowserInstallTarget["browserId"];
  readonly browserName: string;
  readonly path: string;
  readonly changed: boolean;
}

export function createNativeMessagingManifest(options: {
  readonly wrapperPath: string;
  readonly allowedOrigins: readonly string[];
  readonly hostName?: string | undefined;
  readonly description?: string | undefined;
}): NativeMessagingManifest {
  return {
    name: options.hostName ?? DEFAULT_MANIFEST_HOST_NAME,
    description: options.description ?? DEFAULT_MANIFEST_DESCRIPTION,
    path: options.wrapperPath,
    type: "stdio",
    allowed_origins: [...options.allowedOrigins],
  };
}

export async function writeNativeMessagingManifests(options: {
  readonly targets: readonly BrowserInstallTarget[];
  readonly wrapperPath: string;
  readonly allowedOrigins: readonly string[];
  readonly hostName?: string;
  readonly description?: string;
}): Promise<readonly ManifestInstallResult[]> {
  const manifest = createNativeMessagingManifest({
    wrapperPath: options.wrapperPath,
    allowedOrigins: options.allowedOrigins,
    hostName: options.hostName,
    description: options.description,
  });
  const content = `${JSON.stringify(manifest, null, 2)}\n`;

  const results: ManifestInstallResult[] = [];
  for (const target of options.targets) {
    const path = getNativeMessagingManifestPath(target);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    let previous: string | null = null;
    try {
      previous = await readFile(path, "utf8");
    } catch {}

    const changed = previous !== content;
    if (changed) {
      await writeFile(path, content, { mode: 0o644 });
    }

    results.push({
      browserId: target.browserId,
      browserName: target.browserName,
      path,
      changed,
    });
  }

  return results;
}

export async function readNativeMessagingManifests(
  targets: readonly BrowserInstallTarget[],
): Promise<
  readonly {
    readonly browserId: BrowserInstallTarget["browserId"];
    readonly browserName: string;
    readonly path: string;
    readonly present: boolean;
    readonly manifest: NativeMessagingManifest | null;
  }[]
> {
  const results = [];
  for (const target of targets) {
    const path = getNativeMessagingManifestPath(target);
    try {
      const content = await readFile(path, "utf8");
      results.push({
        browserId: target.browserId,
        browserName: target.browserName,
        path,
        present: true,
        manifest: JSON.parse(content) as NativeMessagingManifest,
      });
    } catch {
      results.push({
        browserId: target.browserId,
        browserName: target.browserName,
        path,
        present: false,
        manifest: null,
      });
    }
  }

  return results;
}

export async function removeNativeMessagingManifests(
  targets: readonly BrowserInstallTarget[],
): Promise<readonly string[]> {
  const removed: string[] = [];
  for (const target of targets) {
    const path = getNativeMessagingManifestPath(target);
    await rm(path, { force: true });
    removed.push(path);
  }
  return removed;
}
