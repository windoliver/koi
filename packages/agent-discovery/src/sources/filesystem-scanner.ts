/**
 * Filesystem scanner — discovers agents from a JSON registry directory.
 *
 * Reads all `*.json` files from a directory, validates their shape,
 * and returns descriptors with `source: "filesystem"`.
 *
 * Missing directory (ENOENT) → empty array (not an error).
 * Invalid JSON → skip entry, report via onSkip callback.
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExternalAgentDescriptor, ExternalAgentTransport } from "@koi/core";
import type { DiscoverySource } from "../types.js";

const VALID_TRANSPORTS = new Set<string>(["cli", "mcp", "a2a"]);

/** Type-safe descriptor shape returned by validation. */
interface ValidatedDescriptor {
  readonly name: string;
  readonly transport: ExternalAgentTransport;
  readonly capabilities: readonly string[];
  readonly displayName?: string | undefined;
  readonly command?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** Validate and narrow a parsed JSON value to a descriptor shape. */
function isValidDescriptor(value: unknown): value is ValidatedDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) return false;
  if (typeof obj.transport !== "string" || !VALID_TRANSPORTS.has(obj.transport)) return false;
  if (!Array.isArray(obj.capabilities)) return false;
  if (!obj.capabilities.every((c: unknown) => typeof c === "string")) return false;
  // Validate optional fields — must be correct type if present
  if (obj.displayName !== undefined && typeof obj.displayName !== "string") return false;
  if (obj.command !== undefined && typeof obj.command !== "string") return false;
  if (obj.metadata !== undefined && (typeof obj.metadata !== "object" || obj.metadata === null))
    return false;
  return true;
}

/** Check if an error is an ENOENT (file/directory not found). */
function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export interface FilesystemSourceConfig {
  readonly registryDir: string;
  /** Called when a file is skipped during discovery. Defaults to no-op. */
  readonly onSkip?: ((filepath: string, reason: string) => void) | undefined;
}

/**
 * Creates a DiscoverySource that reads JSON agent descriptors from a directory.
 */
export function createFilesystemSource(config: string | FilesystemSourceConfig): DiscoverySource {
  const registryDir = typeof config === "string" ? config : config.registryDir;
  const onSkip = typeof config === "object" ? config.onSkip : undefined;

  return {
    name: "filesystem",

    discover: async (): Promise<readonly ExternalAgentDescriptor[]> => {
      // let justified: directory may not exist yet
      let jsonFiles: readonly string[];
      try {
        const dirEntries = await readdir(registryDir);
        jsonFiles = dirEntries.filter((f) => f.endsWith(".json"));
      } catch (e: unknown) {
        if (isEnoent(e)) return [];
        throw new Error(`[agent-discovery] Failed to read registry directory: ${registryDir}`, {
          cause: e,
        });
      }

      const resolvedBase = resolve(registryDir);

      return jsonFiles
        .flatMap((filename) => {
          const filepath = join(registryDir, filename);
          // Guard against path traversal — resolved path must stay within registryDir
          const resolvedPath = resolve(filepath);
          if (!resolvedPath.startsWith(`${resolvedBase}/`)) {
            onSkip?.(filepath, "Path escape attempt blocked");
            return [];
          }
          return [{ filepath, filename }];
        })
        .reduce<Promise<readonly ExternalAgentDescriptor[]>>(async (accPromise, { filepath }) => {
          const acc = await accPromise;
          try {
            const content: unknown = await Bun.file(filepath).json();
            if (!isValidDescriptor(content)) {
              onSkip?.(filepath, "Missing required fields or invalid shape");
              return acc;
            }
            const descriptor: ExternalAgentDescriptor = {
              name: content.name,
              displayName: content.displayName,
              transport: content.transport,
              command: content.command,
              capabilities: content.capabilities,
              healthy: undefined,
              source: "filesystem",
              metadata: content.metadata,
            };
            return [...acc, descriptor];
          } catch (e: unknown) {
            onSkip?.(
              filepath,
              `Failed to read or parse: ${e instanceof Error ? e.message : String(e)}`,
            );
            return acc;
          }
        }, Promise.resolve([]));
    },
  };
}
