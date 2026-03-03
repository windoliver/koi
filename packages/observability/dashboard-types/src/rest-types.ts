/**
 * REST API response types for the dashboard.
 *
 * All responses use the ApiResult<T> envelope — a discriminated union
 * that separates success from error without throwing.
 */

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiError };

export interface ApiError {
  readonly code: string;
  readonly message: string;
}
