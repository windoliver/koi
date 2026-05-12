import type { KoiError } from "@koi/core";

/**
 * REST envelope used by every dashboard HTTP route. Mirrors `Result<T>` from
 * `@koi/core` so server and client share one discriminated union.
 *
 * The wire JSON literally serialises this shape — clients can JSON.parse and
 * narrow on `.ok`.
 */
export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KoiError };

/**
 * Cursor-paginated page wrapper used by list endpoints. `nextCursor` is opaque
 * to the client — pass it back verbatim in the next request to fetch the
 * subsequent page. Absent or empty means no more pages.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | undefined;
}
