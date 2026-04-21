import { describe, expect, test } from "bun:test";
import type { S3BlobStoreConfig } from "../config.js";
import { validateS3BlobStoreConfig } from "../config.js";

/**
 * `validateS3BlobStoreConfig` guards the L2 `@koi/artifacts-s3` blob store at
 * construction time. Misconfigured S3 credentials are a programmer / operator
 * error surfaced synchronously — not a runtime Result — per `policy.ts` style
 * and spec §8 security (explicit creds only, never from env implicitly).
 */

function minimalConfig(): S3BlobStoreConfig {
  return {
    bucket: "my-koi-artifacts",
    region: "us-east-1",
    credentials: {
      accessKeyId: "AKIA000000EXAMPLE",
      secretAccessKey: "secret/example/key",
    },
  };
}

describe("validateS3BlobStoreConfig", () => {
  test("accepts a valid minimal config", () => {
    expect(() => validateS3BlobStoreConfig(minimalConfig())).not.toThrow();
  });

  test("accepts a config with optional prefix, endpoint, forcePathStyle, sessionToken", () => {
    expect(() =>
      validateS3BlobStoreConfig({
        ...minimalConfig(),
        prefix: "blobs/cas",
        endpoint: "https://s3.example.com",
        forcePathStyle: true,
        credentials: {
          ...minimalConfig().credentials,
          sessionToken: "FwoGZXIvYXdzEC",
        },
      }),
    ).not.toThrow();
  });

  test("accepts an empty string prefix", () => {
    expect(() => validateS3BlobStoreConfig({ ...minimalConfig(), prefix: "" })).not.toThrow();
  });

  describe("bucket", () => {
    test("throws when missing", () => {
      const cfg = minimalConfig();
      const { bucket: _bucket, ...rest } = cfg;
      expect(() => validateS3BlobStoreConfig(rest as unknown as S3BlobStoreConfig)).toThrow(
        /bucket/,
      );
    });

    test("throws when empty string", () => {
      expect(() => validateS3BlobStoreConfig({ ...minimalConfig(), bucket: "" })).toThrow(/bucket/);
    });

    test.each([
      { value: "ab", label: "too short (2 chars)" },
      { value: "a".repeat(64), label: "too long (64 chars)" },
      { value: "My-Bucket", label: "uppercase letters" },
      { value: "my_bucket", label: "underscore" },
      { value: "my.bucket", label: "dot" },
      { value: "-my-bucket", label: "leading hyphen" },
      { value: "my-bucket-", label: "trailing hyphen" },
      { value: "my bucket", label: "whitespace" },
    ])("throws when bucket has forbidden chars: $label", ({ value }) => {
      expect(() => validateS3BlobStoreConfig({ ...minimalConfig(), bucket: value })).toThrow(
        /bucket/,
      );
    });

    test("accepts 3-char and 63-char bucket names at the boundary", () => {
      expect(() => validateS3BlobStoreConfig({ ...minimalConfig(), bucket: "abc" })).not.toThrow();
      expect(() =>
        validateS3BlobStoreConfig({ ...minimalConfig(), bucket: "a".repeat(63) }),
      ).not.toThrow();
    });
  });

  describe("region", () => {
    test("throws when missing (no implicit env lookup)", () => {
      const cfg = minimalConfig();
      const { region: _region, ...rest } = cfg;
      expect(() => validateS3BlobStoreConfig(rest as unknown as S3BlobStoreConfig)).toThrow(
        /region/,
      );
    });

    test("throws when empty string", () => {
      expect(() => validateS3BlobStoreConfig({ ...minimalConfig(), region: "" })).toThrow(/region/);
    });
  });

  describe("credentials", () => {
    test("throws when credentials missing (no implicit env lookup)", () => {
      const cfg = minimalConfig();
      const { credentials: _credentials, ...rest } = cfg;
      expect(() => validateS3BlobStoreConfig(rest as unknown as S3BlobStoreConfig)).toThrow(
        /credentials/,
      );
    });

    test("throws when accessKeyId is empty", () => {
      expect(() =>
        validateS3BlobStoreConfig({
          ...minimalConfig(),
          credentials: { ...minimalConfig().credentials, accessKeyId: "" },
        }),
      ).toThrow(/accessKeyId/);
    });

    test("throws when secretAccessKey is empty", () => {
      expect(() =>
        validateS3BlobStoreConfig({
          ...minimalConfig(),
          credentials: { ...minimalConfig().credentials, secretAccessKey: "" },
        }),
      ).toThrow(/secretAccessKey/);
    });

    test("session token is optional (missing is fine)", () => {
      expect(() => validateS3BlobStoreConfig(minimalConfig())).not.toThrow();
    });

    test("throws when sessionToken is an empty string (treat as misconfiguration)", () => {
      expect(() =>
        validateS3BlobStoreConfig({
          ...minimalConfig(),
          credentials: { ...minimalConfig().credentials, sessionToken: "" },
        }),
      ).toThrow(/sessionToken/);
    });
  });

  describe("prefix", () => {
    test.each([
      { value: "/blobs", label: "leading slash" },
      { value: "blobs/", label: "trailing slash" },
      { value: "blobs/../escape", label: "parent traversal" },
      { value: "../etc", label: "leading parent traversal" },
    ])("throws when prefix is invalid: $label", ({ value }) => {
      expect(() => validateS3BlobStoreConfig({ ...minimalConfig(), prefix: value })).toThrow(
        /prefix/,
      );
    });

    test("accepts a nested prefix without leading/trailing slashes", () => {
      expect(() =>
        validateS3BlobStoreConfig({ ...minimalConfig(), prefix: "tenant-a/blobs" }),
      ).not.toThrow();
    });
  });
});
