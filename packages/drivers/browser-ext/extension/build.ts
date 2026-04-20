import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const EXTENSION_ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(EXTENSION_ROOT, "../dist/extension");
const KEYS_DIR = join(EXTENSION_ROOT, "keys");
const PEM_PATH = join(KEYS_DIR, "dev.pem");
const PUB_B64_PATH = join(KEYS_DIR, "dev.pub.b64");
const EXT_ID_PATH = join(KEYS_DIR, "dev.extension-id.txt");
const KEY_PLACEHOLDER = "__DEV_PUBLIC_KEY__";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function deriveExtensionId(publicKeyDerBase64: string): string {
  // Chrome's extension ID is the first 16 bytes of SHA-256(public key DER),
  // mapped onto the alphabet a-p (each nibble 0-15 → 'a' + nibble).
  const hash = createHash("sha256")
    .update(new Uint8Array(Buffer.from(publicKeyDerBase64, "base64")))
    .digest();
  return hash
    .slice(0, 16)
    .toString("hex")
    .split("")
    .map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)))
    .join("");
}

/**
 * Generates a PER-DEVELOPER local RSA key pair for dev-mode extension signing
 * the first time the extension is built. Keys are stored under `extension/keys/`
 * (gitignored) so each developer ends up with a distinct extension ID. This
 * keeps the extension ↔ native-host trust boundary local to the machine that
 * runs the install — no globally-trusted shared key in source control.
 */
async function ensureDevKeys(): Promise<{ publicKeyBase64: string; extensionId: string }> {
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 });

  let pubBase64: string;
  if (await exists(PUB_B64_PATH)) {
    pubBase64 = (await readFile(PUB_B64_PATH, "utf8")).trim();
  } else {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    await writeFile(PEM_PATH, privateKey, { mode: 0o600 });
    // SubjectPublicKeyInfo DER → base64 (matches Chrome's expected `key`
    // manifest format).
    const pubDer = Buffer.from(
      publicKey
        .replace(/-----BEGIN PUBLIC KEY-----/, "")
        .replace(/-----END PUBLIC KEY-----/, "")
        .replace(/\s+/g, ""),
      "base64",
    );
    pubBase64 = pubDer.toString("base64");
    await writeFile(PUB_B64_PATH, pubBase64, { mode: 0o600 });
    console.log("[build:extension] generated new dev key pair");
  }

  const extensionId = deriveExtensionId(pubBase64);
  await writeFile(EXT_ID_PATH, `${extensionId}\n`, { mode: 0o600 });
  return { publicKeyBase64: pubBase64, extensionId };
}

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

async function writeManifest(publicKeyBase64: string): Promise<void> {
  const manifestSource = await readFile(join(EXTENSION_ROOT, "manifest.json"), "utf8");
  const manifest = manifestSource.replace(KEY_PLACEHOLDER, publicKeyBase64);
  await writeFile(join(OUT_DIR, "manifest.json"), manifest);
}

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const { publicKeyBase64, extensionId } = await ensureDevKeys();

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

  await writeManifest(publicKeyBase64);
  await copyOptionalFile("options.html");
  await copyOptionalFile("popup.html");
  console.log(`[build:extension] wrote ${OUT_DIR} (extension id: ${extensionId})`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
