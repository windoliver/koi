import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_AUTH_DIR } from "./auth.js";

const INSTALL_ID_PATTERN = /^[0-9a-f]{64}$/;

export async function generateInstallId(dir: string = DEFAULT_AUTH_DIR): Promise<string> {
  const id = randomBytes(32).toString("hex");
  const path = join(dir, "installId");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${id}\n`, { mode: 0o600 });
  return id;
}

export async function readInstallId(dir: string = DEFAULT_AUTH_DIR): Promise<string> {
  const path = join(dir, "installId");
  let content: string;
  try {
    content = (await readFile(path, "utf-8")).trim();
  } catch (cause) {
    throw new Error(`installId: file ${path} not readable`, { cause });
  }
  if (!INSTALL_ID_PATTERN.test(content)) {
    throw new Error(`installId: file ${path} contains malformed value`);
  }
  return content;
}
