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
 * The extension ID is derived per-install from the local dev key pair under
 * `extension/keys/` (gitignored — `build:extension` generates a fresh pair on
 * first build). This keeps extension ↔ native-host trust bound to the
 * installing machine instead of a globally-shared key in source control.
 */
async function readLocalExtensionId(packageRoot: string): Promise<string> {
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
        `Local extension id not found at ${idPath}. Run \`bun run build:extension\` in ` +
          "@koi/browser-ext first — it generates a per-developer dev key and derives the id.",
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
  const hostEntrypointPath = join(packageRoot, "dist", "native-host", "index.js");
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
