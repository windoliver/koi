/**
 * Static asset serving for the dashboard UI.
 *
 * Serves files from the configured assetsDir with appropriate cache headers:
 * - Content-hashed files (e.g. index-a1b2c3.js) → immutable cache
 * - index.html → no-cache (SPA fallback)
 */

import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Content-type detection
// ---------------------------------------------------------------------------

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".map": "application/json",
};

function getContentType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Cache headers
// ---------------------------------------------------------------------------

/** Check if filename contains a content hash (e.g. index-a1b2c3d4.js) */
function isContentHashed(filename: string): boolean {
  // Match patterns like: name-hash.ext or name.hash.ext
  return /[-.][\da-f]{8,}\./.test(filename);
}

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

// ---------------------------------------------------------------------------
// Static file handler
// ---------------------------------------------------------------------------

export interface StaticServeResult {
  readonly serve: (pathname: string) => Promise<Response | null>;
}

export function createStaticServe(assetsDir: string): StaticServeResult {
  const serve = async (pathname: string): Promise<Response | null> => {
    // Resolve to a safe path within assetsDir
    const relativePath = pathname.startsWith("/") ? pathname.slice(1) : pathname;

    // Prevent path traversal
    if (relativePath.includes("..")) {
      return null;
    }

    const filePath = resolve(assetsDir, relativePath);

    // Ensure resolved path is within assetsDir
    if (!filePath.startsWith(resolve(assetsDir))) {
      return null;
    }

    const file = Bun.file(filePath);
    const exists = await file.exists();

    if (!exists) {
      return null;
    }

    const contentType = getContentType(filePath);
    const filename = filePath.slice(filePath.lastIndexOf("/") + 1);
    const cacheControl = isContentHashed(filename) ? IMMUTABLE_CACHE : NO_CACHE;

    return new Response(file, {
      headers: {
        "content-type": contentType,
        "cache-control": cacheControl,
      },
    });
  };

  return { serve };
}
