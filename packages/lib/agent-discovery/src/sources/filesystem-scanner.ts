import { homedir } from "node:os";
import type { ExternalAgentDescriptor, ExternalAgentTransport } from "@koi/core";
import { SOURCE_PRIORITY } from "../constants.js";
import { createDefaultSystemCalls } from "../system-calls.js";
import type { DiscoverySource, SystemCalls } from "../types.js";

export interface FilesystemSourceConfig {
  readonly registryDir: string;
  readonly systemCalls?: SystemCalls;
  readonly onSkip?: (filepath: string, reason: string) => void;
}

function expandTilde(path: string): string {
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

function isExternalAgentTransport(v: unknown): v is ExternalAgentTransport {
  return v === "cli" || v === "mcp" || v === "a2a";
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function createFilesystemSource(config: FilesystemSourceConfig): DiscoverySource {
  const dir = expandTilde(config.registryDir);
  if (dir.split("/").includes("..")) {
    throw new Error(`VALIDATION: registryDir contains path traversal: ${config.registryDir}`);
  }
  const sc = config.systemCalls ?? createDefaultSystemCalls();
  const onSkip = config.onSkip;

  return {
    id: "filesystem",
    priority: SOURCE_PRIORITY.filesystem,
    discover: async (): Promise<readonly ExternalAgentDescriptor[]> => {
      let files: readonly string[];
      try {
        files = await sc.readDir(dir);
      } catch (e: unknown) {
        // Missing directory is a normal "no agents registered" state.
        // Surface every other failure (perms, I/O) via onSkip so operators
        // can detect broken discovery instead of getting a silent empty list.
        const isMissingDir =
          typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
        if (!isMissingDir) {
          onSkip?.(dir, e instanceof Error ? e.message : String(e));
        }
        return [];
      }
      const out: ExternalAgentDescriptor[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filepath = `${dir}/${file}`;
        let parsed: unknown;
        try {
          const text = await sc.readFile(filepath);
          parsed = JSON.parse(text);
        } catch (e: unknown) {
          onSkip?.(filepath, e instanceof Error ? e.message : String(e));
          continue;
        }
        if (!isRecord(parsed)) {
          onSkip?.(filepath, "not a JSON object");
          continue;
        }
        const { name, transport, capabilities, displayName, command } = parsed;
        if (
          typeof name !== "string" ||
          !isExternalAgentTransport(transport) ||
          !isStringArray(capabilities)
        ) {
          onSkip?.(filepath, "missing required fields (name, transport, capabilities)");
          continue;
        }
        out.push({
          name,
          displayName: typeof displayName === "string" ? displayName : undefined,
          transport,
          command: typeof command === "string" ? command : undefined,
          capabilities,
          source: "filesystem",
        });
      }
      return out;
    },
  };
}
