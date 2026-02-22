/**
 * Built-in filesystem tool — read, write, list files.
 *
 * Uses Bun.file() APIs for performance. Respects allowed paths
 * to prevent directory traversal attacks.
 */

import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import type { Tool, ToolDescriptor } from "@koi/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DESCRIPTOR: ToolDescriptor = {
  name: "filesystem",
  description: "Read, write, and list files on the local filesystem",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Operation to perform: read, write, list",
      },
      path: {
        type: "string",
        description: "File or directory path",
      },
      content: {
        type: "string",
        description: "Content to write (only for write action)",
      },
    },
    required: ["action", "path"],
  },
};

/** Maximum file size for read operations (10 MiB). */
const MAX_READ_BYTES = 10_485_760;

/** Maximum content size for write operations (10 MiB). */
const MAX_WRITE_BYTES = 10_485_760;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFilesystemTool(allowedPaths: readonly string[] = [process.cwd()]): Tool {
  // Pre-resolve allowed paths at creation time (including symlink resolution)
  const resolvedAllowedPaths = allowedPaths.map((p) => {
    try {
      return realpathSync(resolve(normalize(p)));
    } catch {
      // Path doesn't exist yet — fall back to normalized resolution
      return resolve(normalize(p));
    }
  });

  /**
   * Check if a target path is under an allowed directory.
   * Uses realpath to resolve symlinks, and appends "/" to prevent prefix bypass
   * (e.g. /tmp/foo must not match /tmp/foobar).
   */
  async function isPathAllowed(targetPath: string): Promise<boolean> {
    try {
      // Try to resolve symlinks for existing paths
      const real = await realpath(resolve(normalize(targetPath)));
      return resolvedAllowedPaths.some(
        (allowed) => real === allowed || real.startsWith(`${allowed}/`),
      );
    } catch {
      // Path doesn't exist yet (write case) — check the parent directory
      const parent = resolve(normalize(targetPath), "..");
      try {
        const realParent = await realpath(parent);
        return resolvedAllowedPaths.some(
          (allowed) => realParent === allowed || realParent.startsWith(`${allowed}/`),
        );
      } catch {
        return false;
      }
    }
  }

  return {
    descriptor: DESCRIPTOR,
    trustTier: "promoted",

    async execute(args) {
      const action = args.action;
      const path = args.path;

      if (typeof action !== "string" || typeof path !== "string") {
        return { error: "Invalid arguments: action and path must be strings" };
      }

      if (!(await isPathAllowed(path))) {
        return { error: "Path access denied" };
      }

      switch (action) {
        case "read": {
          try {
            const file = Bun.file(path);
            const exists = await file.exists();
            if (!exists) {
              return { error: "File not found" };
            }
            if (file.size > MAX_READ_BYTES) {
              return {
                error: `File too large: ${file.size} bytes exceeds ${MAX_READ_BYTES} byte limit`,
              };
            }
            const content = await file.text();
            return { content, size: file.size };
          } catch {
            return { error: "File read failed" };
          }
        }

        case "write": {
          const content = args.content;
          if (typeof content !== "string") {
            return { error: "write action requires 'content' string" };
          }
          if (content.length > MAX_WRITE_BYTES) {
            return {
              error: `Content too large: ${content.length} bytes exceeds ${MAX_WRITE_BYTES} byte limit`,
            };
          }
          try {
            await Bun.write(path, content);
            return { written: true, path };
          } catch {
            return { error: "File write failed" };
          }
        }

        case "list": {
          try {
            const entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: path }));
            return { entries, count: entries.length };
          } catch {
            return { error: "Directory listing failed" };
          }
        }

        default:
          return { error: `Unknown action: ${String(action)}. Use 'read', 'write', or 'list'.` };
      }
    },
  };
}
