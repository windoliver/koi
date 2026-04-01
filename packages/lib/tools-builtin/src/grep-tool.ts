import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { JsonObject, Tool, ToolExecuteOptions, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import {
  clampPath,
  DEFAULT_HEAD_LIMIT,
  looksLikeRegex,
  MAX_NATIVE_GREP_FILE_SIZE,
  validateGlobPattern,
} from "./constants.js";

export interface GrepToolConfig {
  readonly cwd: string;
  readonly policy?: ToolPolicy;
}

export function createGrepTool(config: GrepToolConfig): Tool {
  const { cwd, policy = DEFAULT_UNSANDBOXED_POLICY } = config;

  return {
    descriptor: {
      name: "Grep",
      description:
        "Content search powered by ripgrep (with native fallback). Supports regex, " +
        "file type filtering, multiline matching, context lines, and paginated output.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "File or directory to search in" },
          glob: { type: "string", description: 'Glob filter for files (e.g. "*.ts")' },
          type: { type: "string", description: 'File type filter (e.g. "ts", "py")' },
          output_mode: {
            type: "string",
            enum: ["content", "files_with_matches", "count"],
            description: "Output mode (default: files_with_matches)",
          },
          multiline: { type: "boolean", description: "Enable multiline matching" },
          context: { type: "number", description: "Lines of context before and after" },
          head_limit: {
            type: "number",
            description: `Max output lines (default ${DEFAULT_HEAD_LIMIT}, 0 for unlimited)`,
          },
          offset: { type: "number", description: "Skip first N lines" },
          "-A": { type: "number", description: "Lines after each match" },
          "-B": { type: "number", description: "Lines before each match" },
          "-C": { type: "number", description: "Alias for context" },
          "-i": { type: "boolean", description: "Case-insensitive search" },
          "-n": { type: "boolean", description: "Show line numbers (default true)" },
        },
        required: ["pattern"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> => {
      const signal = options?.signal;
      signal?.throwIfAborted();

      const pattern = args.pattern;
      if (typeof pattern !== "string" || pattern.trim() === "") {
        return { error: "pattern must be a non-empty string" };
      }

      // Clamp path to workspace root
      if (typeof args.path === "string") {
        const clamped = clampPath(args.path, cwd);
        if (!clamped.ok) return { error: clamped.error };
      }

      // Reject glob filters with traversal segments
      if (typeof args.glob === "string") {
        const globError = validateGlobPattern(args.glob);
        if (globError) return { error: globError };
      }

      const rgResult = await tryRg(args, cwd, signal);
      if (rgResult.available) {
        if (!rgResult.ok) return { error: rgResult.error };
        const paginated = applyPagination(rgResult.stdout, args);
        return {
          result: paginated,
          mode: "rg" as const,
          truncated: rgResult.truncated,
          warnings: rgResult.warnings,
        };
      }

      // rg not installed — fail closed if pattern needs regex semantics
      if (looksLikeRegex(pattern.trim())) {
        return {
          error:
            "ripgrep (rg) is not installed. This pattern contains regex metacharacters " +
            "that cannot be matched with the literal-string fallback. Install rg or use a plain literal pattern.",
        };
      }

      // Native literal-search fallback (plain strings only)
      try {
        const maxOutputLines = computeMaxOutputLines(args);
        const { output, skippedFiles, truncated } = await nativeGrep(
          args,
          cwd,
          maxOutputLines,
          signal,
        );
        const paginated = applyPagination(output, args);
        const warnings: string[] = [
          "rg unavailable — results use literal string matching, not regex",
        ];
        if (skippedFiles.length > 0) {
          warnings.push(
            `${skippedFiles.length} file(s) skipped (too large, binary, or unreadable)`,
          );
        }
        return {
          result: paginated,
          mode: "literal" as const,
          truncated,
          warnings,
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { error: `Grep fallback failed: ${msg}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// ripgrep backend (preferred)
// ---------------------------------------------------------------------------

type RgResult =
  | {
      readonly available: true;
      readonly ok: true;
      readonly stdout: string;
      readonly truncated: boolean;
      readonly warnings: readonly string[];
    }
  | { readonly available: true; readonly ok: false; readonly error: string }
  | { readonly available: false };

async function tryRg(args: JsonObject, cwd: string, signal?: AbortSignal): Promise<RgResult> {
  try {
    signal?.throwIfAborted();

    const rgArgs = buildRgArgs(args, cwd);
    const proc = Bun.spawn(["rg", ...rgArgs], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Kill rg when the engine signals abort/timeout
    const onAbort = (): void => {
      try {
        proc.kill();
      } catch {
        // Already exited
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Close spawn/listener race: if signal was aborted between the
    // throwIfAborted() check and addEventListener, kill immediately
    if (signal?.aborted) {
      onAbort();
    }

    const headLimit = typeof args.head_limit === "number" ? args.head_limit : DEFAULT_HEAD_LIMIT;
    const offset = typeof args.offset === "number" && args.offset > 0 ? args.offset : 0;
    const maxLines = headLimit > 0 ? offset + headLimit : 0; // 0 = unlimited

    // Drain stderr concurrently to prevent pipe buffer deadlock.
    // If rg emits many warnings (unreadable files, etc.) and stderr
    // fills up, rg blocks. Reading both streams concurrently avoids this.
    const stderrPromise = new Response(proc.stderr).text();

    const collectedLines: string[] = [];
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let partial = "";
    let killedByUs = false;

    // eslint-disable-next-line no-constant-condition -- stream loop
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      partial += decoder.decode(chunk.value, { stream: true });
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      let limitReached = false;
      for (const line of parts) {
        collectedLines.push(line);
        if (maxLines > 0 && collectedLines.length >= maxLines) {
          limitReached = true;
          break;
        }
      }
      if (limitReached) {
        killedByUs = true;
        try {
          proc.kill();
        } catch {
          // Already exited
        }
        break;
      }
    }
    if (partial && !killedByUs) collectedLines.push(partial);

    const stderrTrimmed = (await stderrPromise).trim();
    const exitCode = await proc.exited;
    signal?.removeEventListener("abort", onAbort);

    // Check if we were aborted by the engine signal (not our own head-limit kill)
    if (signal?.aborted && !killedByUs) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const warnings: string[] = [];
    if (killedByUs)
      warnings.push("Results truncated — search killed after collecting enough lines");
    if (stderrTrimmed) warnings.push(stderrTrimmed);

    const normalExit = exitCode === 0 || exitCode === 1;
    const isSuccess = normalExit || (killedByUs && !hasRgError(stderrTrimmed));

    if (isSuccess) {
      return {
        available: true,
        ok: true,
        stdout: collectedLines.join("\n"),
        truncated: killedByUs,
        warnings,
      };
    }
    return {
      available: true,
      ok: false,
      error: stderrTrimmed || `rg exited with code ${exitCode}`,
    };
  } catch (e: unknown) {
    // Only treat ENOENT (binary not found) as "rg unavailable".
    // Other spawn failures (permissions, resource exhaustion) are real errors.
    const msg = e instanceof Error ? e.message : String(e);
    const code = e instanceof Error && "code" in e ? (e as { code: string }).code : "";
    if (code === "ENOENT" || msg.includes("ENOENT")) {
      return { available: false };
    }
    return { available: true, ok: false, error: msg };
  }
}

/** Check if rg stderr contains a real error (not just per-file warnings). */
function hasRgError(stderr: string): boolean {
  if (!stderr) return false;
  // rg per-file warnings start with the file path; real errors are typically
  // "error:" prefixed or contain "No such file" for bad arguments.
  return stderr.includes("error:") || stderr.includes("No such file or directory");
}

// ---------------------------------------------------------------------------
// Native Bun fallback (no rg dependency)
// ---------------------------------------------------------------------------

interface NativeGrepResult {
  readonly output: string;
  readonly skippedFiles: readonly string[];
  readonly truncated: boolean;
}

function computeMaxOutputLines(args: JsonObject): number {
  const headLimit = typeof args.head_limit === "number" ? args.head_limit : DEFAULT_HEAD_LIMIT;
  const offset = typeof args.offset === "number" && args.offset > 0 ? args.offset : 0;
  return headLimit > 0 ? offset + headLimit : 0; // 0 = unlimited
}

async function nativeGrep(
  args: JsonObject,
  cwd: string,
  maxOutputLines: number,
  signal?: AbortSignal,
): Promise<NativeGrepResult> {
  // Native fallback uses literal string matching only (not regex).
  // This guarantees linear-time execution and prevents catastrophic
  // backtracking that could hang the process. Regex patterns are
  // treated as literal strings; full regex support requires rg.
  const patternStr = (args.pattern as string).trim();
  const caseInsensitive = args["-i"] === true;
  const needle = caseInsensitive ? patternStr.toLowerCase() : patternStr;

  const searchPath =
    typeof args.path === "string" ? clampPath(args.path, cwd) : { ok: true as const, path: cwd };
  if (!searchPath.ok) return { output: "", skippedFiles: [], truncated: false };
  const resolvedPath = searchPath.path;

  const mode = typeof args.output_mode === "string" ? args.output_mode : "files_with_matches";

  const fileGlob =
    typeof args.glob === "string"
      ? args.glob
      : typeof args.type === "string"
        ? `**/*.${args.type}`
        : "**/*";

  const glob = new Bun.Glob(fileGlob);
  const isFile = statSync(resolvedPath, { throwIfNoEntry: false })?.isFile() ?? false;

  signal?.throwIfAborted();

  // Stream files directly from the glob iterator into the search loop
  // instead of pre-collecting all files. Hard cap on files scanned to
  // bound work in degraded mode (no rg).
  const MAX_FILES_SCANNED = 50_000;

  const outputLines: string[] = [];
  const skippedFiles: string[] = [];
  const isMultiline = args.multiline === true;
  let truncated = false;
  let filesScanned = 0;

  // File source: either a single file or streamed from glob
  async function* fileSource(): AsyncGenerator<string> {
    if (isFile) {
      yield resolvedPath;
    } else {
      for await (const match of glob.scan({
        cwd: resolvedPath,
        onlyFiles: true,
        followSymlinks: false,
      })) {
        yield match;
      }
    }
  }

  for await (const file of fileSource()) {
    signal?.throwIfAborted();
    if (filesScanned >= MAX_FILES_SCANNED) {
      truncated = true;
      break;
    }
    filesScanned++;
    const fullPath = isFile ? file : join(resolvedPath, file);
    // Always normalize to workspace-relative paths for consistent output
    const relPath = relative(cwd, fullPath);

    // Re-clamp each matched file to catch descendant symlinks escaping cwd
    const fileClamp = clampPath(fullPath, cwd);
    if (!fileClamp.ok) {
      skippedFiles.push(`${relPath} (symlink escape)`);
      continue;
    }

    const fileStat = statSync(fullPath, { throwIfNoEntry: false });
    if (!fileStat || fileStat.size > MAX_NATIVE_GREP_FILE_SIZE) {
      skippedFiles.push(relPath);
      continue;
    }

    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      skippedFiles.push(relPath);
      continue;
    }

    if (content.slice(0, 8192).includes("\0")) {
      skippedFiles.push(relPath);
      continue;
    }

    const lines = content.split("\n");
    const matchingLineNums: number[] = [];

    if (isMultiline) {
      // Multiline: search full content for literal needle
      const haystack = caseInsensitive ? content.toLowerCase() : content;
      let searchFrom = 0;
      while (searchFrom < haystack.length) {
        const idx = haystack.indexOf(needle, searchFrom);
        if (idx === -1) break;
        // Map byte offset to line number
        let lineNum = 0;
        let charCount = 0;
        for (let i = 0; i < lines.length; i++) {
          if (charCount + (lines[i]?.length ?? 0) >= idx) {
            lineNum = i;
            break;
          }
          charCount += (lines[i]?.length ?? 0) + 1;
        }
        if (!matchingLineNums.includes(lineNum)) {
          matchingLineNums.push(lineNum);
        }
        searchFrom = idx + Math.max(1, needle.length);
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        const line = caseInsensitive ? (lines[i] ?? "").toLowerCase() : (lines[i] ?? "");
        if (line.includes(needle)) {
          matchingLineNums.push(i);
        }
      }
    }

    if (matchingLineNums.length === 0) continue;

    if (mode === "files_with_matches") {
      outputLines.push(relPath);
    } else if (mode === "count") {
      outputLines.push(`${relPath}:${matchingLineNums.length}`);
    } else {
      const contextBefore = typeof args["-B"] === "number" ? args["-B"] : 0;
      const contextAfter = typeof args["-A"] === "number" ? args["-A"] : 0;
      const contextBoth =
        typeof args["-C"] === "number"
          ? args["-C"]
          : typeof args.context === "number"
            ? args.context
            : 0;
      const before = Math.max(contextBefore, contextBoth);
      const after = Math.max(contextAfter, contextBoth);
      const showN = args["-n"] !== false;

      const emittedLines = new Set<number>();
      for (const lineNum of matchingLineNums) {
        const start = Math.max(0, lineNum - before);
        const end = Math.min(lines.length - 1, lineNum + after);
        for (let i = start; i <= end; i++) emittedLines.add(i);
      }

      const sortedLines = [...emittedLines].sort((a, b) => a - b);
      for (const idx of sortedLines) {
        const prefix = showN ? `${idx + 1}:` : "";
        outputLines.push(`${relPath}:${prefix}${lines[idx]}`);
      }
    }

    // Early termination: stop scanning files once we have enough output
    if (maxOutputLines > 0 && outputLines.length >= maxOutputLines) {
      truncated = true;
      break;
    }
  }

  return { output: outputLines.join("\n"), skippedFiles, truncated };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildRgArgs(args: JsonObject, cwd: string): readonly string[] {
  const rgArgs: string[] = [];
  const pattern = args.pattern as string;

  const mode = typeof args.output_mode === "string" ? args.output_mode : "files_with_matches";
  if (mode === "files_with_matches") rgArgs.push("-l");
  else if (mode === "count") rgArgs.push("-c");

  if (args.multiline === true) rgArgs.push("-U", "--multiline-dotall");
  if (args["-i"] === true) rgArgs.push("-i");

  const showLineNumbers = args["-n"] !== false && mode === "content";
  if (showLineNumbers) rgArgs.push("-n");

  const contextVal = typeof args["-C"] === "number" ? args["-C"] : args.context;
  if (typeof contextVal === "number") rgArgs.push("-C", String(contextVal));
  if (typeof args["-A"] === "number") rgArgs.push("-A", String(args["-A"]));
  if (typeof args["-B"] === "number") rgArgs.push("-B", String(args["-B"]));

  if (typeof args.glob === "string") rgArgs.push("--glob", args.glob);
  if (typeof args.type === "string") rgArgs.push("--type", args.type);

  rgArgs.push("--", pattern.trim());

  // Normalize search path to cwd-relative so rg output is workspace-relative.
  // Path is already clamped by execute().
  if (typeof args.path === "string") {
    rgArgs.push(relative(cwd, resolve(cwd, args.path)));
  } else {
    rgArgs.push(".");
  }

  return rgArgs;
}

function applyPagination(stdout: string, args: JsonObject): string {
  const headLimit = typeof args.head_limit === "number" ? args.head_limit : DEFAULT_HEAD_LIMIT;
  const offset = typeof args.offset === "number" && args.offset > 0 ? args.offset : 0;

  const lines = stdout.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const sliced = offset > 0 ? lines.slice(offset) : lines;
  const limited = headLimit > 0 ? sliced.slice(0, headLimit) : sliced;
  return limited.join("\n");
}
