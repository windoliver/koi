import { cp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateInstallId } from "../native-host/index.js";
import { generateAuthFiles } from "./auth-files.js";
import { getBrowserInstallTargets, type SupportedPlatform } from "./browsers.js";
import { writeHostWrapper } from "./host-wrapper.js";
import { DEFAULT_MANIFEST_HOST_NAME, writeNativeMessagingManifests } from "./nm-manifest.js";
import { detectNodeBinary, type NodeDetectionResult } from "./node-detect.js";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * The extension ID is derived at build time from the dev key pair and
 * embedded into the shipped bundle at `dist/extension/extension-id.txt`.
 * Packaged installs read it from the bundle so they do not depend on any
 * gitignored repo-local state. Source-tree installs fall back to
 * `extension/keys/dev.extension-id.txt` for developer convenience when the
 * bundle has not been produced yet.
 */
async function readBundledExtensionId(bundleDir: string): Promise<string> {
  const idPath = join(bundleDir, "extension-id.txt");
  const content = (await readFile(idPath, "utf8")).trim();
  if (!/^[a-p]{32}$/.test(content)) {
    throw new Error(`extension id at ${idPath} has unexpected format`);
  }
  return content;
}

async function readLocalExtensionId(packageRoot: string): Promise<string> {
  // Preferred source: shipped bundle artifact. This is what a packaged
  // `@koi/browser-ext` install sees.
  try {
    return await readBundledExtensionId(join(packageRoot, "dist", "extension"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  // Fallback: source-tree dev artifact (gitignored, written by
  // `bun run build:extension`). Keeps local dev ergonomic without making
  // the release path depend on it.
  const idPath = join(packageRoot, "extension", "keys", "dev.extension-id.txt");
  try {
    const content = (await readFile(idPath, "utf8")).trim();
    if (!/^[a-p]{32}$/.test(content)) {
      throw new Error(`extension id at ${idPath} has unexpected format`);
    }
    return content;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        "No extension id found. Expected either a shipped bundle at " +
          `${join(packageRoot, "dist", "extension", "extension-id.txt")} ` +
          `or a dev artifact at ${idPath}. Run \`bun run build:extension\` ` +
          "in @koi/browser-ext to produce both.",
      );
    }
    throw err;
  }
}

export interface InstallCommandOptions {
  readonly homeDir?: string;
  readonly packageRoot?: string;
  readonly platform?: SupportedPlatform;
  readonly dev?: boolean;
}

export interface InstallCommandResult {
  readonly installId: string;
  readonly node: NodeDetectionResult;
  readonly authDir: string;
  readonly wrapperPath: string;
  readonly hostEntrypointPath: string;
  readonly extensionSourceDir: string;
  readonly extensionDeployDir: string;
  readonly manifestsWritten: readonly string[];
}

export interface InstallCommandDependencies {
  readonly detectNodeBinary?: typeof detectNodeBinary;
  readonly generateInstallId?: typeof generateInstallId;
  readonly generateAuthFiles?: typeof generateAuthFiles;
  readonly writeHostWrapper?: typeof writeHostWrapper;
  readonly writeNativeMessagingManifests?: typeof writeNativeMessagingManifests;
  readonly copyExtensionBundle?: (from: string, to: string) => Promise<void>;
  readonly getBrowserInstallTargets?: typeof getBrowserInstallTargets;
  readonly ensureExtensionBundle?: (dir: string) => Promise<void>;
  readonly readLocalExtensionId?: (packageRoot: string) => Promise<string>;
  readonly ensureHostEntrypoint?: (path: string) => Promise<void>;
}

async function defaultCopyExtensionBundle(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await cp(from, to, { recursive: true, force: true });
}

async function ensureExtensionBundle(dir: string): Promise<void> {
  // Require BOTH manifest.json AND extension-id.txt in the shipped bundle.
  // extension-id.txt is what the native-messaging manifest's allowed_origins
  // references; a bundle missing it means the installer would fall back to
  // a repo-local dev id that does not correspond to the bundle actually
  // being copied — producing a silently broken install where Chrome
  // refuses the native host connection.
  const manifestSource = await readFile(join(dir, "manifest.json"), "utf8");
  await readFile(join(dir, "extension-id.txt"), "utf8");
  // Parse the manifest and verify every referenced asset actually exists
  // in the bundle. A partial/stale build can otherwise pass validation and
  // write auth files + NM manifests, only for Chrome to fail at load-time
  // after the install state has already been committed under ~/.koi.
  let manifest: {
    readonly background?: { readonly service_worker?: string };
    readonly action?: { readonly default_popup?: string };
    readonly options_page?: string;
    readonly options_ui?: { readonly page?: string };
    readonly icons?: Record<string, string>;
  };
  try {
    manifest = JSON.parse(manifestSource) as typeof manifest;
  } catch (err) {
    throw new Error(
      `browser-ext install: manifest.json at ${dir} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const referenced: string[] = [];
  if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker);
  if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup);
  if (manifest.options_page) referenced.push(manifest.options_page);
  if (manifest.options_ui?.page) referenced.push(manifest.options_ui.page);
  if (manifest.icons) {
    for (const path of Object.values(manifest.icons)) {
      if (typeof path === "string") referenced.push(path);
    }
  }
  for (const relPath of referenced) {
    try {
      await readFile(join(dir, relPath));
    } catch (err) {
      throw new Error(
        `browser-ext install: manifest.json references missing asset "${relPath}" in ${dir}. ` +
          "Bundle is incomplete — rebuild with `bun run build` before install. " +
          `(cause: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}

async function ensureHostEntrypoint(path: string): Promise<void> {
  await readFile(path);
}

export async function runInstallCommand(
  options: InstallCommandOptions = {},
  deps: InstallCommandDependencies = {},
): Promise<InstallCommandResult> {
  // The dev and release install paths are identical — same dist/ bundle,
  // same wrapper, same native-messaging manifests. `options.dev` is kept
  // for forward compatibility (future signed-store install flow may differ),
  // but we no longer hard-fail on `dev: false`. Both paths go through
  // bundle verification + asset checks below, so a stale/incomplete build
  // is caught regardless.
  const homeDir = options.homeDir ?? homedir();
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const platform = options.platform ?? (process.platform as SupportedPlatform);
  const authDir = join(homeDir, ".koi", "browser-ext");
  const wrapperPath = join(authDir, "bin", "native-host");
  const extensionSourceDir = join(packageRoot, "dist", "extension");
  const extensionDeployDir = join(authDir, "extension");
  // Copy the ENTIRE native-host runtime tree into a durable location under
  // authDir and point the wrapper at that copy. The previous layout baked
  // `packageRoot/dist/bin/native-host-main.js` into the wrapper — fine for
  // source-tree dev, but with `bunx @koi/browser-ext install` packageRoot
  // is a transient bun cache location that can be evicted after install.
  // That leaves Chrome pointed at a vanished path.
  const runtimeSourceDir = join(packageRoot, "dist");
  const runtimeDeployDir = join(authDir, "runtime");
  const hostEntrypointSourcePath = join(runtimeSourceDir, "bin", "native-host-main.js");
  const hostEntrypointPath = join(runtimeDeployDir, "bin", "native-host-main.js");

  const detectNode = deps.detectNodeBinary ?? detectNodeBinary;
  const generateInstall = deps.generateInstallId ?? generateInstallId;
  const writeAuth = deps.generateAuthFiles ?? generateAuthFiles;
  const writeWrapper = deps.writeHostWrapper ?? writeHostWrapper;
  const writeManifests = deps.writeNativeMessagingManifests ?? writeNativeMessagingManifests;
  const copyBundle = deps.copyExtensionBundle ?? defaultCopyExtensionBundle;
  const browserTargets = (deps.getBrowserInstallTargets ?? getBrowserInstallTargets)(
    platform,
    homeDir,
  );
  const verifyBundle = deps.ensureExtensionBundle ?? ensureExtensionBundle;

  await verifyBundle(extensionSourceDir);
  // Verify the production host entrypoint exists in the source tree before
  // we copy it. A partial build that lacks the entrypoint would otherwise
  // succeed install-time and fail at chrome.runtime.connectNative() runtime.
  const verifyHostEntrypoint = deps.ensureHostEntrypoint ?? ensureHostEntrypoint;
  await verifyHostEntrypoint(hostEntrypointSourcePath).catch((err: unknown) => {
    throw new Error(
      `browser-ext install: host entrypoint missing at ${hostEntrypointSourcePath}. ` +
        "Run `bun run build` in @koi/browser-ext before install. " +
        `(cause: ${err instanceof Error ? err.message : String(err)})`,
    );
  });
  const readExtensionId = deps.readLocalExtensionId ?? readLocalExtensionId;
  // Prefer the extension id derived from the bundle we're about to copy —
  // NOT a source-tree fallback that could diverge from the deployed
  // artifact. This keeps allowed_origins locked to the actual bundle.
  const extensionId = await readExtensionId(packageRoot);
  const node = detectNode();
  const installId = await generateInstall(authDir);
  await writeAuth(authDir);
  // Copy the native-host runtime into the managed install dir BEFORE writing
  // the wrapper so the wrapper points at a durable path that survives
  // removal of the transient packageRoot (bunx cache eviction, package
  // upgrade, monorepo checkout moves).
  await copyBundle(runtimeSourceDir, runtimeDeployDir);
  await writeWrapper(wrapperPath, node.executablePath, hostEntrypointPath);
  const manifests = await writeManifests({
    targets: browserTargets,
    wrapperPath,
    allowedOrigins: [`chrome-extension://${extensionId}/`],
    hostName: DEFAULT_MANIFEST_HOST_NAME,
  });
  await copyBundle(extensionSourceDir, extensionDeployDir);

  return {
    installId,
    node,
    authDir,
    wrapperPath,
    hostEntrypointPath,
    extensionSourceDir,
    extensionDeployDir,
    manifestsWritten: manifests.map((manifest) => manifest.path),
  };
}

export function formatInstallSummary(result: InstallCommandResult): string {
  return [
    `Install ID: ${result.installId}`,
    `Node: ${result.node.version} (${result.node.executablePath})`,
    `Wrapper: ${result.wrapperPath}`,
    `Extension deploy dir: ${result.extensionDeployDir}`,
    "Next step: open chrome://extensions, enable Developer mode, then load the unpacked extension from the deploy dir above.",
  ].join("\n");
}
