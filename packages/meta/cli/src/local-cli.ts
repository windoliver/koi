import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const LOCAL_CLI_BIN = join("packages", "meta", "cli", "dist", "bin.js");

function toScriptPath(path: string): string {
  const normalized = sep === "\\" ? path.replaceAll("\\", "/") : path;
  if (normalized.startsWith(".") || normalized.startsWith("/")) {
    return normalized;
  }
  return `./${normalized}`;
}

function isKoiRepoRoot(dir: string): boolean {
  const packageJsonPath = join(dir, "package.json");
  const cliBinPath = join(dir, LOCAL_CLI_BIN);
  if (!existsSync(packageJsonPath) || !existsSync(cliBinPath)) {
    return false;
  }

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      readonly name?: unknown;
    };
    return pkg.name === "koi" || pkg.name === "koi-monorepo";
  } catch {
    return false;
  }
}

export function resolveScaffoldKoiCommand(targetDir: string): string {
  let currentDir = targetDir;

  while (true) {
    if (isKoiRepoRoot(currentDir)) {
      return toScriptPath(relative(targetDir, join(currentDir, LOCAL_CLI_BIN)));
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return "koi";
    }
    currentDir = parentDir;
  }
}
