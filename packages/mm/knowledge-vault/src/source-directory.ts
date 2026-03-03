/**
 * Directory source — scans a directory tree for markdown files.
 *
 * Supports two discovery paths:
 * - **Backend provided**: uses FileSystemBackend.list() + .read() for remote/abstract FS
 * - **No backend (default)**: uses Bun.Glob + Bun.file() for local FS
 *
 * Parses frontmatter, extracts title/tags, and truncates content to the
 * configured index char limit.
 */

import { join } from "node:path";
import type { FileSystemBackend, TokenEstimator } from "@koi/core";

import { parseFrontmatter } from "./frontmatter.js";
import type { DirectorySourceConfig, ParsedDocument, ScanResult } from "./types.js";
import { DEFAULT_GLOB } from "./types.js";

/** Options controlling directory scan behavior. */
export interface ScanOptions {
  readonly maxIndexCharsPerDoc: number;
  readonly maxWarnings: number;
  readonly batchSize: number;
  readonly estimator: TokenEstimator;
}

/**
 * Scan a directory for markdown files and parse them into documents.
 *
 * When `config.backend` is provided, delegates discovery to the backend's
 * `list()` and reading to `read()`. Otherwise falls back to Bun APIs.
 */
export async function scanDirectory(
  config: DirectorySourceConfig,
  options: ScanOptions,
): Promise<ScanResult> {
  if (config.backend !== undefined) {
    return scanWithBackend(config, config.backend, options);
  }
  return scanWithBun(config, options);
}

// ---------------------------------------------------------------------------
// Path A: FileSystemBackend
// ---------------------------------------------------------------------------

async function scanWithBackend(
  config: DirectorySourceConfig,
  backend: FileSystemBackend,
  options: ScanOptions,
): Promise<ScanResult> {
  const globPattern = config.glob ?? DEFAULT_GLOB;
  const maxChars = options.maxIndexCharsPerDoc;

  const listResult = await backend.list(config.path, {
    recursive: true,
    glob: globPattern,
  });

  if (!listResult.ok) {
    return {
      documents: [],
      warnings: [`Failed to list directory "${config.path}": ${listResult.error.message}`],
    };
  }

  // Filter to files only, apply exclude patterns
  const paths = listResult.value.entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path)
    .filter((path) => !shouldExclude(path, config.exclude));

  const documents: ParsedDocument[] = [];
  const warnings: string[] = [];

  for (const batch of batches(paths, options.batchSize)) {
    const results = await Promise.allSettled(
      batch.map((filePath) =>
        readAndParseFromBackend(backend, filePath, maxChars, options.estimator),
      ),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        documents.push(result.value);
      } else {
        if (warnings.length < options.maxWarnings) {
          const reason =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          warnings.push(reason);
        }
      }
    }
  }

  return { documents, warnings };
}

async function readAndParseFromBackend(
  backend: FileSystemBackend,
  filePath: string,
  maxChars: number,
  estimator: TokenEstimator,
): Promise<ParsedDocument> {
  const readResult = await backend.read(filePath);

  if (!readResult.ok) {
    throw new Error(`Failed to read "${filePath}": ${readResult.error.message}`);
  }

  const raw = readResult.value.content;

  // Guard against binary files — check for null bytes
  if (raw.includes("\0")) {
    throw new Error(`Binary file skipped: ${filePath}`);
  }

  const { metadata, body } = parseFrontmatter(raw);
  const title = extractTitle(metadata, filePath);
  const tags = extractTags(metadata);
  const truncatedBody = body.slice(0, maxChars);

  const tokenResult = estimator.estimateText(truncatedBody);
  const tokens = typeof tokenResult === "number" ? tokenResult : await tokenResult;

  return {
    path: filePath,
    title,
    body: truncatedBody,
    frontmatter: metadata,
    tags,
    lastModified: Date.now(),
    tokens,
  };
}

// ---------------------------------------------------------------------------
// Path B: Bun APIs (default, backward compat)
// ---------------------------------------------------------------------------

async function scanWithBun(
  config: DirectorySourceConfig,
  options: ScanOptions,
): Promise<ScanResult> {
  const globPattern = config.glob ?? DEFAULT_GLOB;
  const maxChars = options.maxIndexCharsPerDoc;
  const glob = new Bun.Glob(globPattern);

  // Collect all matching paths
  const paths: string[] = [];
  for await (const path of glob.scan({ cwd: config.path, dot: false })) {
    if (shouldExclude(path, config.exclude)) continue;
    paths.push(path);
  }

  // Batch-read files
  const documents: ParsedDocument[] = [];
  const warnings: string[] = [];

  for (const batch of batches(paths, options.batchSize)) {
    const results = await Promise.allSettled(
      batch.map((relativePath) =>
        readAndParseBun(config.path, relativePath, maxChars, options.estimator),
      ),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        documents.push(result.value);
      } else {
        if (warnings.length < options.maxWarnings) {
          const reason =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          warnings.push(reason);
        }
      }
    }
  }

  return { documents, warnings };
}

async function readAndParseBun(
  basePath: string,
  relativePath: string,
  maxChars: number,
  estimator: TokenEstimator,
): Promise<ParsedDocument> {
  const fullPath = join(basePath, relativePath);
  const file = Bun.file(fullPath);
  const stat = await file.stat();
  const raw = await file.text();

  // Guard against binary files — check for null bytes
  if (raw.includes("\0")) {
    throw new Error(`Binary file skipped: ${relativePath}`);
  }

  const { metadata, body } = parseFrontmatter(raw);
  const title = extractTitle(metadata, relativePath);
  const tags = extractTags(metadata);
  const truncatedBody = body.slice(0, maxChars);

  const tokenResult = estimator.estimateText(truncatedBody);
  const tokens = typeof tokenResult === "number" ? tokenResult : await tokenResult;

  return {
    path: relativePath,
    title,
    body: truncatedBody,
    frontmatter: metadata,
    tags,
    lastModified: stat.mtimeMs,
    tokens,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function extractTitle(metadata: Readonly<Record<string, unknown>>, fallbackPath: string): string {
  const title = metadata.title;
  if (typeof title === "string" && title !== "") return title;

  // Derive from filename
  const segments = fallbackPath.split("/");
  const filename = segments[segments.length - 1] ?? fallbackPath;
  return filename.replace(/\.md$/i, "").replace(/[-_]/g, " ");
}

function extractTags(metadata: Readonly<Record<string, unknown>>): readonly string[] {
  const raw = metadata.tags;
  if (Array.isArray(raw)) {
    return raw
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t !== "");
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
  }
  return [];
}

function shouldExclude(path: string, excludePatterns: readonly string[] | undefined): boolean {
  if (excludePatterns === undefined || excludePatterns.length === 0) {
    return false;
  }
  return excludePatterns.some((pattern) => {
    const glob = new Bun.Glob(pattern);
    return glob.match(path);
  });
}

/** Yield batches of items from an array. */
function* batches<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (
    // let is required — loop counter
    let i = 0;
    i < items.length;
    i += size
  ) {
    yield items.slice(i, i + size);
  }
}
