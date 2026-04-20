/**
 * S3 blob store configuration + synchronous validation.
 *
 * `validateS3BlobStoreConfig` is invoked from the factory that constructs an
 * S3-backed `BlobStore` (Task 2 in Plan 5); misconfigured S3 credentials are a
 * programmer / operator error, so it throws synchronously rather than
 * returning a `Result`. This mirrors `@koi/artifacts`' `validateLifecyclePolicy`
 * — surface bad config at store construction, never at save time.
 *
 * Security (docs/superpowers/specs/2026-04-18-artifacts-design.md §8):
 *   - `region`, `bucket`, and `credentials` are all REQUIRED. This package
 *     NEVER reads credentials from the environment implicitly. Callers must
 *     pass an explicit `S3BlobStoreConfig` — typically derived from a vetted
 *     secret manager in the host application.
 *   - Config objects must never be logged; caller responsibility.
 */

export interface S3BlobStoreConfig {
  readonly bucket: string;
  /**
   * Optional key prefix under which blobs are written. Must not start or end
   * with `/` (the blob-store layer adds separators as needed) and must not
   * contain `..` traversal segments. Empty string is the default (bucket
   * root).
   */
  readonly prefix?: string;
  /** AWS region (e.g. `us-east-1`). Required — no implicit env lookup. */
  readonly region: string;
  /** Static credentials. Required — no implicit env lookup per spec §8. */
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  /** Custom endpoint for S3-compatible stores (MinIO, Cloudflare R2, etc.). */
  readonly endpoint?: string;
  /** Force path-style addressing (bucket in path, not subdomain). */
  readonly forcePathStyle?: boolean;
}

/**
 * S3 bucket naming rules — conservative subset of the AWS spec:
 *   3-63 chars, lowercase letters, digits, and hyphens only; must start and
 *   end with a letter or digit. Dots are disallowed to sidestep TLS-cert and
 *   virtual-host gotchas.
 */
const BUCKET_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `S3BlobStoreConfig.${field} is required and must be a non-empty string; got ${String(value)}. Credentials are never read from the environment — callers must supply an explicit value.`,
    );
  }
}

function validateBucket(bucket: unknown): void {
  assertNonEmptyString(bucket, "bucket");
  if (typeof bucket === "string" && !BUCKET_REGEX.test(bucket)) {
    throw new Error(
      `S3BlobStoreConfig.bucket must be 3-63 chars of lowercase letters, digits, or hyphens (no leading/trailing hyphen, no dots); got ${JSON.stringify(bucket)}. Dots are rejected to avoid TLS-cert + virtual-host edge cases.`,
    );
  }
}

function validatePrefix(prefix: unknown): void {
  if (prefix === undefined) return;
  if (typeof prefix !== "string") {
    throw new Error(
      `S3BlobStoreConfig.prefix must be a string when provided; got ${String(prefix)}.`,
    );
  }
  if (prefix === "") return; // empty prefix = bucket root, explicitly allowed
  if (prefix.startsWith("/") || prefix.endsWith("/")) {
    throw new Error(
      `S3BlobStoreConfig.prefix must not start or end with '/'; got ${JSON.stringify(prefix)}. The blob-store layer adds separators as needed.`,
    );
  }
  if (prefix.split("/").some((segment) => segment === "..")) {
    throw new Error(
      `S3BlobStoreConfig.prefix must not contain '..' traversal segments; got ${JSON.stringify(prefix)}.`,
    );
  }
}

function isCredentialsObject(value: unknown): value is {
  readonly accessKeyId?: unknown;
  readonly secretAccessKey?: unknown;
  readonly sessionToken?: unknown;
} {
  return typeof value === "object" && value !== null;
}

function validateCredentials(credentials: unknown): void {
  if (!isCredentialsObject(credentials)) {
    throw new Error(
      `S3BlobStoreConfig.credentials is required and must be an object; got ${String(credentials)}. Credentials are never read from the environment — callers must supply explicit accessKeyId + secretAccessKey.`,
    );
  }
  assertNonEmptyString(credentials.accessKeyId, "credentials.accessKeyId");
  assertNonEmptyString(credentials.secretAccessKey, "credentials.secretAccessKey");
  // sessionToken is optional; if present, it must be non-empty (empty string is
  // always a misconfiguration — treat as programmer error).
  if (credentials.sessionToken !== undefined) {
    assertNonEmptyString(credentials.sessionToken, "credentials.sessionToken");
  }
}

export function validateS3BlobStoreConfig(config: S3BlobStoreConfig): void {
  if (config === null || typeof config !== "object") {
    throw new Error(
      `S3BlobStoreConfig must be an object; got ${String(config)}. No implicit defaults — pass an explicit config per spec §8.`,
    );
  }
  validateBucket(config.bucket);
  assertNonEmptyString(config.region, "region");
  validateCredentials(config.credentials);
  validatePrefix(config.prefix);
}
