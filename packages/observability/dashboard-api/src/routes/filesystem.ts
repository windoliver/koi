/**
 * Filesystem REST routes — thin wrappers over FileSystemBackend (L0).
 *
 * GET    /fs/list?path=     — list directory contents
 * GET    /fs/read?path=     — read file content
 * GET    /fs/search?q=       — search file contents (optional: glob, maxResults, path)
 * DELETE /fs/file?path=     — delete a file
 */

import type { FileSystemBackend } from "@koi/core";
import type { RouteParams } from "../router.js";
import { errorResponse, jsonResponse } from "../router.js";

function getQueryParam(req: Request, name: string): string | undefined {
  const url = new URL(req.url);
  return url.searchParams.get(name) ?? undefined;
}

function getAllQueryParams(req: Request, name: string): string[] {
  const url = new URL(req.url);
  return url.searchParams.getAll(name);
}

export async function handleFsList(
  req: Request,
  _params: RouteParams,
  fileSystem: FileSystemBackend,
): Promise<Response> {
  const path = getQueryParam(req, "path") ?? "/";
  const recursive = getQueryParam(req, "recursive") === "true";
  const glob = getQueryParam(req, "glob");

  const listOptions = glob !== undefined ? { recursive, glob } : { recursive };
  const result = await fileSystem.list(path, listOptions);
  if (!result.ok) {
    const status = result.error.code === "NOT_FOUND" ? 404 : 500;
    return errorResponse(result.error.code, result.error.message, status);
  }
  return jsonResponse(result.value);
}

export async function handleFsRead(
  req: Request,
  _params: RouteParams,
  fileSystem: FileSystemBackend,
): Promise<Response> {
  const path = getQueryParam(req, "path");
  if (path === undefined) {
    return errorResponse("VALIDATION", "Missing 'path' query parameter", 400);
  }

  const result = await fileSystem.read(path);
  if (!result.ok) {
    const status = result.error.code === "NOT_FOUND" ? 404 : 500;
    return errorResponse(result.error.code, result.error.message, status);
  }
  return jsonResponse(result.value);
}

export async function handleFsSearch(
  req: Request,
  _params: RouteParams,
  fileSystem: FileSystemBackend,
): Promise<Response> {
  const query = getQueryParam(req, "q");
  if (query === undefined) {
    return errorResponse("VALIDATION", "Missing 'q' query parameter", 400);
  }

  const maxResultsRaw = getQueryParam(req, "maxResults");
  const maxResults = maxResultsRaw !== undefined ? Number.parseInt(maxResultsRaw, 10) : undefined;
  const scopePaths = getAllQueryParams(req, "path");

  const searchGlob = getQueryParam(req, "glob");
  const searchOptions: { glob?: string; maxResults?: number } = {};
  if (searchGlob !== undefined) searchOptions.glob = searchGlob;

  // When scoping by path, fetch more results from backend to ensure enough
  // survive the path filter, then truncate to the requested maxResults.
  if (scopePaths.length > 0) {
    const expanded =
      maxResults !== undefined && !Number.isNaN(maxResults) ? Math.min(maxResults * 5, 500) : 500;
    searchOptions.maxResults = expanded;
  } else if (maxResults !== undefined && !Number.isNaN(maxResults)) {
    searchOptions.maxResults = maxResults;
  }

  const result = await fileSystem.search(query, searchOptions);
  if (!result.ok) {
    return errorResponse(result.error.code, result.error.message, 500);
  }

  let matches = result.value.matches;

  // Filter by path scope(s) server-side before truncating
  if (scopePaths.length > 0) {
    matches = matches.filter((m) => scopePaths.some((sp) => m.path.startsWith(sp)));
  }

  // Truncate to requested maxResults after path filtering
  const limit = maxResults !== undefined && !Number.isNaN(maxResults) ? maxResults : undefined;
  if (limit !== undefined && matches.length > limit) {
    matches = matches.slice(0, limit);
  }

  return jsonResponse({ matches, truncated: result.value.truncated });
}

export async function handleFsDelete(
  req: Request,
  _params: RouteParams,
  fileSystem: FileSystemBackend,
): Promise<Response> {
  const path = getQueryParam(req, "path");
  if (path === undefined) {
    return errorResponse("VALIDATION", "Missing 'path' query parameter", 400);
  }

  if (fileSystem.delete === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Delete not supported by this filesystem", 501);
  }

  const result = await fileSystem.delete(path);
  if (!result.ok) {
    const status = result.error.code === "NOT_FOUND" ? 404 : 500;
    return errorResponse(result.error.code, result.error.message, status);
  }
  return jsonResponse(result.value);
}
