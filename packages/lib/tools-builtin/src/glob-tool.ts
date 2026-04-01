import { statSync } from "node:fs";
import { join, relative } from "node:path";
import type { JsonObject, Tool, ToolExecuteOptions, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { clampPath, validateGlobPattern } from "./constants.js";

export interface GlobToolConfig {
  readonly cwd: string;
  readonly policy?: ToolPolicy;
}

export function createGlobTool(config: GlobToolConfig): Tool {
  const { cwd, policy = DEFAULT_UNSANDBOXED_POLICY } = config;

  return {
    descriptor: {
      name: "Glob",
      description:
        "Fast file pattern matching. Returns matching file paths sorted by " +
        "modification time (most recent first).",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: 'Glob pattern to match files (e.g. "**/*.ts", "src/**/*.test.ts")',
          },
          path: {
            type: "string",
            description: "Directory to search in. Defaults to the working directory.",
          },
        },
        required: ["pattern"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> => {
      const pattern = args.pattern;
      if (typeof pattern !== "string" || pattern.trim() === "") {
        return { error: "pattern must be a non-empty string" };
      }

      const patternError = validateGlobPattern(pattern.trim());
      if (patternError) return { error: patternError };

      let basePath = cwd;
      if (typeof args.path === "string") {
        const clamped = clampPath(args.path, cwd);
        if (!clamped.ok) return { error: clamped.error };
        basePath = clamped.path;
      }

      const signal = options?.signal;
      signal?.throwIfAborted();

      // Cap scan collection to bound memory/CPU. We collect up to
      // MAX_SCAN entries, stat them, sort by mtime, then return the
      // top MAX_RESULTS. This bounds total work while preserving
      // the "most recent first" guarantee within the scanned set.
      const MAX_SCAN = 50_000;
      const MAX_RESULTS = 10_000;

      const glob = new Bun.Glob(pattern.trim());
      const paths: string[] = [];
      let scanTruncated = false;
      try {
        for await (const match of glob.scan({
          cwd: basePath,
          onlyFiles: true,
          followSymlinks: false,
        })) {
          signal?.throwIfAborted();
          const fullPath = join(basePath, match);
          if (!clampPath(fullPath, cwd).ok) continue;
          // Normalize to workspace-relative so paths are usable from cwd
          paths.push(relative(cwd, fullPath));
          if (paths.length >= MAX_SCAN) {
            scanTruncated = true;
            break;
          }
        }
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") throw e;
        const msg = e instanceof Error ? e.message : String(e);
        return { error: `Glob scan failed: ${msg}` };
      }

      signal?.throwIfAborted();

      const withMtime: { readonly path: string; readonly mtime: number }[] = [];
      for (const p of paths) {
        signal?.throwIfAborted();
        try {
          const stat = statSync(join(cwd, p));
          withMtime.push({ path: p, mtime: stat.mtimeMs });
        } catch {
          withMtime.push({ path: p, mtime: 0 });
        }
      }

      withMtime.sort((a, b) => b.mtime - a.mtime);

      const truncated = scanTruncated || withMtime.length > MAX_RESULTS;
      const final = withMtime.length > MAX_RESULTS ? withMtime.slice(0, MAX_RESULTS) : withMtime;

      // Always return the same envelope shape
      return {
        paths: final.map((entry) => entry.path),
        truncated,
        total: scanTruncated ? undefined : withMtime.length,
      };
    },
  };
}
