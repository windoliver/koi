/**
 * Lightweight URL pattern router for dashboard API.
 *
 * No frameworks — uses `new URL(req.url)` for path matching and
 * simple pattern extraction for route parameters.
 */

import type { ApiResult } from "@koi/dashboard-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteParams {
  readonly [key: string]: string;
}

export type RouteHandler = (req: Request, params: RouteParams) => Response | Promise<Response>;

export interface Route {
  readonly method: string;
  readonly pattern: string;
  readonly handler: RouteHandler;
}

interface CompiledRoute {
  readonly method: string;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
  readonly handler: RouteHandler;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface Router {
  readonly match: (method: string, path: string) => RouteMatch | undefined;
}

export interface RouteMatch {
  readonly handler: RouteHandler;
  readonly params: RouteParams;
}

/** Compile a route pattern (e.g. "/agents/:id") into a regex. */
function compileRoute(route: Route): CompiledRoute {
  const paramNames: string[] = [];
  const regexStr = route.pattern.replace(/:([a-zA-Z0-9_]+)/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });

  return {
    method: route.method,
    regex: new RegExp(`^${regexStr}$`),
    paramNames,
    handler: route.handler,
  };
}

export function createRouter(routes: readonly Route[]): Router {
  const compiled = routes.map(compileRoute);

  const match = (method: string, path: string): RouteMatch | undefined => {
    for (const route of compiled) {
      if (route.method !== method) continue;
      const m = route.regex.exec(path);
      if (m === null) continue;

      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        const name = route.paramNames[i];
        const value = m[i + 1];
        if (name !== undefined && value !== undefined) {
          params[name] = decodeURIComponent(value);
        }
      }
      return { handler: route.handler, params };
    }
    return undefined;
  };

  return { match };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function jsonResponse<T>(data: T, status = 200): Response {
  const body: ApiResult<T> = { ok: true, data };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errorResponse(code: string, message: string, status: number): Response {
  const body: ApiResult<never> = { ok: false, error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Validate a required route parameter. Returns errorResponse(400) if missing. */
export function validateRequiredParam(
  params: RouteParams,
  name: string,
  label?: string,
): string | Response {
  const value = params[name];
  if (value === undefined) {
    return errorResponse("VALIDATION", `Missing ${label ?? name}`, 400);
  }
  return value;
}

/** Map a Result error to an HTTP error response. */
export function mapResultToResponse(result: {
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}): Response | undefined {
  if (result.ok || result.error === undefined) return undefined;
  const code = result.error.code;
  const status =
    code === "NOT_FOUND" ? 404 : code === "PERMISSION" ? 403 : code === "CONFLICT" ? 409 : 500;
  return errorResponse(code, result.error.message, status);
}
