import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const EXTENSION_ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(EXTENSION_ROOT, "../dist/extension");
const KEY_PLACEHOLDER = "__DEV_PUBLIC_KEY__";

async function copyOptionalFile(name: string): Promise<void> {
  const sourcePath = join(EXTENSION_ROOT, "src", name);
  const destinationPath = join(OUT_DIR, name);

  try {
    await copyFile(sourcePath, destinationPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function writeManifest(): Promise<void> {
  const manifestSource = await readFile(join(EXTENSION_ROOT, "manifest.json"), "utf8");
  const publicKey = (await readFile(join(EXTENSION_ROOT, "keys/dev.pub.b64"), "utf8")).trim();
  const manifest = manifestSource.replace(KEY_PLACEHOLDER, publicKey);
  await writeFile(join(OUT_DIR, "manifest.json"), manifest);
}

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  await build({
    entryPoints: {
      "service-worker": join(EXTENSION_ROOT, "src/service-worker.ts"),
      options: join(EXTENSION_ROOT, "src/options.ts"),
    },
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    outdir: OUT_DIR,
    sourcemap: true,
    logLevel: "info",
  });

  await writeManifest();
  await copyOptionalFile("options.html");
  await copyOptionalFile("popup.html");
  console.log(`[build:extension] wrote ${OUT_DIR}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
