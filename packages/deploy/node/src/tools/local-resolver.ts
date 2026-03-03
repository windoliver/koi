/**
 * Local tool resolver — discovers tools from directories + built-in defaults.
 *
 * Implements the Resolver<ToolMeta, Tool> contract from @koi/core.
 * Priority: local config > built-in defaults (first-wins).
 */

import type { KoiError, Result, SourceBundle, Tool, ToolDescriptor } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { createFilesystemTool } from "./filesystem.js";
import { createShellTool } from "./shell.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Config subset used by the resolver (excludes toolCallTimeoutMs which is node-level). */
interface ResolverConfig {
  readonly directories: readonly string[];
  readonly builtins: {
    readonly filesystem: boolean;
    readonly shell: boolean;
  };
}

export interface ToolMeta {
  readonly name: string;
  readonly description: string;
  readonly source: "builtin" | "directory";
}

export interface LocalResolver {
  readonly discover: () => Promise<readonly ToolMeta[]>;
  /** Synchronous list of already-discovered tools. Empty if discover() hasn't been called. */
  readonly list: () => readonly ToolMeta[];
  readonly load: (id: string) => Promise<Result<Tool, KoiError>>;
  readonly source: (id: string) => Promise<Result<SourceBundle, KoiError>>;
  readonly onChange?: (listener: () => void) => () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLocalResolver(config: ResolverConfig): LocalResolver {
  const tools = new Map<string, Tool>();
  const toolSources = new Map<string, "builtin" | "directory">();
  const toolPaths = new Map<string, string>();
  // let: lazy discovery flag, set once after initial scan
  let discovered = false;

  async function ensureDiscovered(): Promise<void> {
    if (discovered) return;

    // Register built-in tools
    if (config.builtins.filesystem) {
      const fsTool = createFilesystemTool();
      tools.set(fsTool.descriptor.name, fsTool);
      toolSources.set(fsTool.descriptor.name, "builtin");
    }
    if (config.builtins.shell) {
      const shellTool = createShellTool();
      tools.set(shellTool.descriptor.name, shellTool);
      toolSources.set(shellTool.descriptor.name, "builtin");
    }

    // Scan configured directories for tool definitions
    for (const dir of config.directories) {
      await scanDirectory(dir);
    }

    discovered = true;
  }

  async function scanDirectory(dir: string): Promise<void> {
    try {
      const entries = await Array.fromAsync(new Bun.Glob("*.tool.json").scan({ cwd: dir }));
      for (const entry of entries) {
        try {
          const filePath = `${dir}/${entry}`;
          const content = await Bun.file(filePath).text();
          const parsed = JSON.parse(content) as Record<string, unknown>;
          const name = typeof parsed.name === "string" ? parsed.name : entry;
          const description = typeof parsed.description === "string" ? parsed.description : "";

          const descriptor: ToolDescriptor = {
            name,
            description,
            inputSchema:
              typeof parsed.inputSchema === "object" && parsed.inputSchema !== null
                ? (parsed.inputSchema as Record<string, unknown>)
                : {},
          };

          // Directory tools execute by running a command (if specified)
          const command = typeof parsed.command === "string" ? parsed.command : undefined;

          const tool: Tool = {
            descriptor,
            trustTier: "sandbox",
            async execute(args) {
              if (command === undefined) {
                return { error: "Tool has no executable command" };
              }
              // Safe env: only PATH/HOME/LANG/TERM, no secrets from process.env
              const safeEnv: Record<string, string> = {};
              for (const key of ["PATH", "HOME", "LANG", "TERM", "SHELL", "TMPDIR"]) {
                const val = process.env[key];
                if (val !== undefined) safeEnv[key] = val;
              }
              const proc = Bun.spawn(["sh", "-c", command], {
                env: safeEnv,
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
              });
              // Pass tool args via stdin instead of env to avoid shell expansion attacks
              proc.stdin.write(JSON.stringify(args));
              proc.stdin.end();
              const stdout = await new Response(proc.stdout).text();
              const exitCode = await proc.exited;
              if (exitCode !== 0) {
                const stderr = await new Response(proc.stderr).text();
                return { error: stderr, exitCode };
              }
              return { output: stdout, exitCode: 0 };
            },
          };

          tools.set(name, tool);
          toolSources.set(name, "directory");
          toolPaths.set(name, filePath);
        } catch {
          // Skip malformed tool definitions
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable — skip silently
    }
  }

  return {
    async discover() {
      await ensureDiscovered();
      return [...tools.entries()].map(([name, tool]) => ({
        name,
        description: tool.descriptor.description,
        source: toolSources.get(name) ?? ("builtin" as const),
      }));
    },

    list() {
      return [...tools.entries()].map(([name, tool]) => ({
        name,
        description: tool.descriptor.description,
        source: toolSources.get(name) ?? ("builtin" as const),
      }));
    },

    async load(id) {
      await ensureDiscovered();
      const tool = tools.get(id);
      if (tool === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Tool not found: ${id}`,
            retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
            context: { toolId: id },
          },
        };
      }
      return { ok: true, value: tool };
    },

    async source(id) {
      await ensureDiscovered();
      const src = toolSources.get(id);
      if (src === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Tool not found: ${id}`,
            retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
            context: { toolId: id },
          },
        };
      }
      if (src === "builtin") {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Built-in tool "${id}" has no readable source. Use Shadow pattern to override.`,
            retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
            context: { toolId: id, source: "builtin" },
          },
        };
      }
      const filePath = toolPaths.get(id);
      if (filePath === undefined) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `No file path tracked for directory tool: ${id}`,
            retryable: false,
            context: { toolId: id },
          },
        };
      }
      try {
        const content = await Bun.file(filePath).text();
        return { ok: true, value: { content, language: "json" as const } };
      } catch (e: unknown) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `Failed to read source for tool "${id}": ${e instanceof Error ? e.message : String(e)}`,
            retryable: false,
            context: { toolId: id, filePath },
          },
        };
      }
    },
  };
}
