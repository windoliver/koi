/**
 * Filesystem REST routes — thin wrappers over FileSystemBackend (L0).
 *
 * GET    /fs/list?path=     — list directory contents
 * GET    /fs/read?path=     — read file content
 * GET    /fs/search?q=&path= — search file contents
 * DELETE /fs/file?path=     — delete a file
 */

import type { FileSystemBackend } from "@koi/core";
import type { RouteParams } from "../router.js";
import { errorResponse, jsonResponse } from "../router.js";

function getQueryParam(req: Request, name: string): string | undefined {
  const url = new URL(req.url);
  return url.searchParams.get(name) ?? undefined;
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

  const searchGlob = getQueryParam(req, "glob");
  const searchOptions: { glob?: string; maxResults?: number } = {};
  if (searchGlob !== undefined) searchOptions.glob = searchGlob;
  if (maxResults !== undefined && !Number.isNaN(maxResults)) searchOptions.maxResults = maxResults;

  const result = await fileSystem.search(query, searchOptions);
  if (!result.ok) {
    return errorResponse(result.error.code, result.error.message, 500);
  }
  return jsonResponse(result.value);
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
