# @koi/artifacts-s3

S3-backed `BlobStore` implementation for `@koi/artifacts`. Lets the artifact store's content-addressed blob layer run against AWS S3 or any S3-compatible object store (MinIO, Cloudflare R2, Backblaze B2) while metadata continues to live in SQLite.

This is Plan 5 of issue #1651 / #1922. It adds a pluggable backend; it does not change any `@koi/artifacts` semantics — the save protocol, startup recovery, repair worker, sweep, and scavenger all run unchanged on top of this backend.

## Public surface

```ts
import { createArtifactStore } from "@koi/artifacts";
import { createS3BlobStore } from "@koi/artifacts-s3";

const blobStore = createS3BlobStore({
  bucket: "my-org-artifacts",
  prefix: "env/prod",            // optional; default: bucket root
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,      // caller resolves from a vetted secret source
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,     // optional
  },
  endpoint: "https://s3.us-east-1.amazonaws.com",    // optional; S3-compatible stores set this
  forcePathStyle: false,                              // optional; true for MinIO / R2
});

const store = await createArtifactStore({
  dbPath: "/path/to/store.db",
  blobDir: "/path/to/blobs",   // unused for S3, but ArtifactStoreConfig still requires it for the writer lock
  blobStore,                    // Plan 5: override the default filesystem CAS
});
```

`createS3BlobStore` validates config synchronously and throws on misconfiguration — bad bucket name, missing region, missing credentials, or illegal prefix. Runtime errors (put/get/has/delete) throw `Error` with `cause` chaining and bubble up to `@koi/artifacts`, which already handles transient blob failures per its repair-worker contract.

## Configuration

```ts
interface S3BlobStoreConfig {
  readonly bucket: string;                 // Required. 3-63 chars, lowercase + digits + hyphens; no dots
  readonly prefix?: string;                // Optional. No leading/trailing '/', no '..' segments
  readonly region: string;                 // Required. No implicit env lookup
  readonly credentials: {                  // Required. No implicit env lookup (spec §8)
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  readonly endpoint?: string;              // For S3-alike stores
  readonly forcePathStyle?: boolean;       // For MinIO / R2
}
```

Every required field is explicit by design. Bucket names reject dots to avoid TLS-cert + virtual-host edge cases. Prefix rejects traversal segments before any S3 call ever fires.

## Security

Per the artifacts design spec (`docs/superpowers/specs/2026-04-18-artifacts-design.md` §8):

- **No implicit env-var credentials.** `region`, `bucket`, and `credentials` are all required. This package never calls into the AWS SDK's default credential chain. Callers must thread credentials from a vetted secret source (secret manager, sealed config, platform-provided IAM role exchange). This prevents a misconfigured deployment from silently picking up stale developer credentials.
- **Config objects must never be logged.** `S3BlobStoreConfig` contains raw secrets. Caller responsibility: scrub before emitting to logs / telemetry / error reports.
- **Transport.** Use HTTPS endpoints in production. The SDK defaults to HTTPS; only override `endpoint` for local testing or private networks you trust.

## Key layout

Keys mirror the filesystem CAS in `@koi/blob-cas`:

```
<prefix>/<shard>/<full-sha256-hex>
```

- `shard` is the first 2 hex chars of the SHA-256. Buys O(1) sharding for `list()` without enumerating the whole bucket.
- `full-sha256-hex` is 64 lowercase hex chars. Anything that fails to match this pattern during `list()` is silently skipped — keeps the backend contract honest even if the bucket hosts unrelated objects under the prefix.
- With an empty prefix, keys start at `<shard>/<hash>` (no leading slash). S3 keys are not paths, and a leading slash would create a surprising empty-segment component.

### Store-id sentinel

Stored at `<prefix>/__store_id__` (or `__store_id__` at bucket root). Paired with `meta.store_id` in SQLite so a stale DB can never rebind to a fresh blob backend (or vice versa). `list()` filters it out by shape — it is neither a 2-char hex shard nor a 64-char hex hash, so the CAS contract never sees it. Reads/writes use standard `GetObject` / `PutObject`; strong read-after-write consistency makes the sentinel durable the moment `writeStoreId` resolves.

## Consistency

Relies on S3's strong read-after-write consistency (global since December 2020) to satisfy the `BlobStore` contract: after `put(h)` resolves, `has(h)` / `get(h)` must reflect its presence. This is the same guarantee every S3-compatible store in production has offered for years — MinIO, R2, and B2 all match.

Without this guarantee, the artifact save protocol's positive-has gate (step 9 in the `@koi/artifacts` save flow) could race and publish unpublishable rows. S3 gives us the guarantee; no retry loop or eventual-consistency workaround is needed.

## Delete cost

`delete(h)` issues two round-trips: `HeadObject` then (if present) `DeleteObject`. This is deliberate and documented cost:

- The `BlobStore` contract requires `delete(missing) → false` and `delete(present) → true`.
- S3 `DeleteObject` is idempotent and returns HTTP 204 whether or not the key existed. There is no in-band way to distinguish.
- The filesystem CAS in `@koi/blob-cas` has the same shape — it `unlink`s and treats `ENOENT` as "not present". We match that behavior at the cost of one extra HEAD per delete.

This cost only shows up in the tombstone-drain path (Phase B) and the repair worker's terminal-delete branch — both are background tasks, not on the save/get hot path. If this ever becomes a real cost center, a future revision can relax the contract to `delete() → void` and push existence tracking into metadata.

## Compatibility with S3-alike stores

| Store | Config |
|---|---|
| AWS S3 | `endpoint` omitted, `forcePathStyle: false` (default) |
| MinIO | `endpoint: "http://minio.internal:9000"`, `forcePathStyle: true` |
| Cloudflare R2 | `endpoint: "https://<account>.r2.cloudflarestorage.com"`, `forcePathStyle: true` |
| Backblaze B2 (S3 API) | `endpoint: "https://s3.<region>.backblazeb2.com"`, `forcePathStyle: false` |

The only moving parts are `endpoint` (always HTTPS in production) and `forcePathStyle` (bucket in path vs. subdomain). `region`, `bucket`, `prefix`, and `credentials` all work identically.

## Testing

Three unit-test suites colocated in `packages/lib/artifacts-s3/src/__tests__/`:

- `config.test.ts` — validation surface: required-field rejection, bucket-regex, prefix traversal guards, empty-credential guards.
- `s3-blob-store.test.ts` — put/get/has/delete/list/sentinel behavior under `aws-sdk-client-mock`, including pagination, NoSuchKey/NotFound mapping, and sentinel sharing semantics.
- `contract.test.ts` — runs the `@koi/blob-cas` shared `runBlobStoreContract` suite against the S3 impl (same assertions that the filesystem CAS passes).

No live S3 in CI. Mocks are deterministic and never touch the network.

## L3 wiring

`@koi/runtime` does not create an S3 blob store by default — the TUI keeps writing to `~/.koi/artifacts/`. Hosts that want S3 persistence pass a pre-built `BlobStore` (from `createS3BlobStore`) into `ArtifactStoreConfig.blobStore`. Golden tests at the runtime layer (`packages/meta/runtime/src/__tests__/golden-replay.test.ts`) exercise both backends via the same trajectory fixtures to guarantee parity.
