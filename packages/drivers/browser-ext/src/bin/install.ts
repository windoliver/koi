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
}

async function defaultCopyExtensionBundle(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await cp(from, to, { recursive: true, force: true });
}

async function ensureExtensionBundle(dir: string): Promise<void> {
  await readFile(join(dir, "manifest.json"), "utf8");
}

export async function runInstallCommand(
  options: InstallCommandOptions = {},
  deps: InstallCommandDependencies = {},
): Promise<InstallCommandResult> {
  if (options.dev === false) {
    throw new Error("Phase 1 only supports the dev extension build. Release install is TODO.");
  }

  const homeDir = options.homeDir ?? homedir();
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const platform = options.platform ?? (process.platform as SupportedPlatform);
  const authDir = join(homeDir, ".koi", "browser-ext");
  const wrapperPath = join(authDir, "bin", "native-host");
  // Wrapper exec's this production entrypoint — it builds a NativeHostConfig
  // from env/install layout and calls runNativeHost(). The `dist/native-host/
  // index.js` barrel is re-exports only and would never start the host.
  const hostEntrypointPath = join(packageRoot, "dist", "bin", "native-host-main.js");
  const extensionSourceDir = join(packageRoot, "dist", "extension");
  const extensionDeployDir = join(authDir, "extension");

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
  const readExtensionId = deps.readLocalExtensionId ?? readLocalExtensionId;
  const extensionId = await readExtensionId(packageRoot);
  const node = detectNode();
  const installId = await generateInstall(authDir);
  await writeAuth(authDir);
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
