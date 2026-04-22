import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

export interface NodeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface NodeDetectionResult {
  readonly executablePath: string;
  readonly version: string;
  readonly parsedVersion: NodeVersion;
}

export interface NodeDetectDependencies {
  readonly execFileSync?: typeof execFileSync;
  readonly existsSync?: typeof existsSync;
  readonly realpathSync?: typeof realpathSync;
}

const MINIMUM_NODE_VERSION: NodeVersion = {
  major: 20,
  minor: 11,
  patch: 0,
};

export function parseNodeVersion(version: string): NodeVersion {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) {
    throw new Error(`Unrecognized Node.js version string: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isSupportedNodeVersion(version: NodeVersion): boolean {
  if (version.major !== MINIMUM_NODE_VERSION.major) {
    return version.major > MINIMUM_NODE_VERSION.major;
  }
  if (version.minor !== MINIMUM_NODE_VERSION.minor) {
    return version.minor > MINIMUM_NODE_VERSION.minor;
  }
  return version.patch >= MINIMUM_NODE_VERSION.patch;
}

export function nodeInstallGuidance(reason: string): string {
  return [
    reason,
    "Node.js 20.11+ is required for @koi/browser-ext because the native host runs on Node in Phase 1.",
    "Install Node.js LTS, then re-run `bunx @koi/browser-ext install`.",
  ].join("\n");
}

export function detectNodeBinary(deps: NodeDetectDependencies = {}): NodeDetectionResult {
  const exec = deps.execFileSync ?? execFileSync;
  const hasPath = deps.existsSync ?? existsSync;
  const resolvePath = deps.realpathSync ?? realpathSync;

  let versionOutput: string;
  try {
    versionOutput = String(exec("node", ["--version"], { encoding: "utf8" })).trim();
  } catch (cause) {
    throw new Error(nodeInstallGuidance("`node --version` failed; Node.js was not found."), {
      cause,
    });
  }

  const parsedVersion = parseNodeVersion(versionOutput);
  if (!isSupportedNodeVersion(parsedVersion)) {
    throw new Error(
      nodeInstallGuidance(
        `Found Node.js ${versionOutput}, but @koi/browser-ext requires Node.js >= 20.11.0.`,
      ),
    );
  }

  let rawPath: string;
  try {
    rawPath = String(exec("which", ["node"], { encoding: "utf8" })).trim();
  } catch (cause) {
    throw new Error(
      nodeInstallGuidance("`which node` failed; could not resolve an absolute path."),
      {
        cause,
      },
    );
  }

  const executablePath = resolvePath(rawPath);
  if (!executablePath.startsWith("/")) {
    throw new Error(nodeInstallGuidance(`Resolved node path is not absolute: ${executablePath}`));
  }
  if (!hasPath(executablePath)) {
    throw new Error(
      nodeInstallGuidance(`Resolved node path does not exist anymore: ${executablePath}`),
    );
  }

  return {
    executablePath,
    version: versionOutput,
    parsedVersion,
  };
}
