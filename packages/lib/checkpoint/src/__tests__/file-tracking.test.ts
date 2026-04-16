/**
 * File-tracking unit tests — `extractPath`, `capturePreImage`/`capturePostImage`,
 * and `buildFileOpRecord`.
 *
 * These verify the building blocks the middleware composes in `wrapToolCall`.
 * The full op-kind matrix tests live in `op-kind-matrix.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolCallId } from "@koi/core";
import {
  buildFileOpRecord,
  capturePostImage,
  capturePreImage,
  extractPath,
} from "../file-tracking.js";

function makeBlobDir(): string {
  const dir = join(tmpdir(), `koi-track-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSourcePath(content?: string): string {
  const path = join(tmpdir(), `koi-track-src-${crypto.randomUUID()}`);
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

describe("extractPath", () => {
  test("extracts a string path", () => {
    expect(extractPath({ path: "/tmp/foo.txt" })).toBe("/tmp/foo.txt");
  });

  test("returns undefined for missing path", () => {
    expect(extractPath({ content: "x" })).toBeUndefined();
  });

  test("returns undefined for empty string path", () => {
    expect(extractPath({ path: "" })).toBeUndefined();
  });

  test("returns undefined for non-string path", () => {
    expect(extractPath({ path: 42 })).toBeUndefined();
    expect(extractPath({ path: null })).toBeUndefined();
    expect(extractPath({ path: { abs: "/tmp" } })).toBeUndefined();
  });
});

describe("capturePreImage", () => {
  let blobDir: string;
  const created: string[] = [];

  beforeEach(() => {
    blobDir = makeBlobDir();
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
    for (const f of created) {
      try {
        unlinkSync(f);
      } catch {
        // ignore
      }
    }
    created.length = 0;
  });

  test("returns existed=false when file does not exist", async () => {
    const result = await capturePreImage(blobDir, "/this/path/does/not/exist");
    expect(result.existed).toBe(false);
    expect(result.contentHash).toBeUndefined();
  });

  test("returns existed=true with hash for existing file", async () => {
    const path = makeSourcePath("hello");
    created.push(path);

    const result = await capturePreImage(blobDir, path);
    expect(result.existed).toBe(true);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("captures hash for an empty file", async () => {
    const path = makeSourcePath("");
    created.push(path);

    const result = await capturePreImage(blobDir, path);
    expect(result.existed).toBe(true);
    expect(result.contentHash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("capturePostImage", () => {
  let blobDir: string;

  beforeEach(() => {
    blobDir = makeBlobDir();
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("returns existed=false when file is gone", async () => {
    const result = await capturePostImage(blobDir, "/this/path/does/not/exist");
    expect(result.existed).toBe(false);
    expect(result.contentHash).toBeUndefined();
  });
});

describe("buildFileOpRecord", () => {
  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);
  const callId = toolCallId("call-1");
  const baseInput = {
    callId,
    path: "/tmp/file.txt",
    turnIndex: 0,
    eventIndex: 0,
  };

  test("create — pre absent, post present", () => {
    const result = buildFileOpRecord({
      ...baseInput,
      pre: { existed: false, contentHash: undefined },
      post: { existed: true, contentHash: HASH_A },
    });
    expect(result?.kind).toBe("create");
    if (result?.kind === "create") {
      expect(result.postContentHash).toBe(HASH_A);
    }
  });

  test("delete — pre present, post absent", () => {
    const result = buildFileOpRecord({
      ...baseInput,
      pre: { existed: true, contentHash: HASH_A },
      post: { existed: false, contentHash: undefined },
    });
    expect(result?.kind).toBe("delete");
    if (result?.kind === "delete") {
      expect(result.preContentHash).toBe(HASH_A);
    }
  });

  test("edit — both present, hashes differ", () => {
    const result = buildFileOpRecord({
      ...baseInput,
      pre: { existed: true, contentHash: HASH_A },
      post: { existed: true, contentHash: HASH_B },
    });
    expect(result?.kind).toBe("edit");
    if (result?.kind === "edit") {
      expect(result.preContentHash).toBe(HASH_A);
      expect(result.postContentHash).toBe(HASH_B);
    }
  });

  test("undefined when nothing happened — both absent", () => {
    const result = buildFileOpRecord({
      ...baseInput,
      pre: { existed: false, contentHash: undefined },
      post: { existed: false, contentHash: undefined },
    });
    expect(result).toBeUndefined();
  });

  test("undefined when both present and hashes match (no-op tool)", () => {
    const result = buildFileOpRecord({
      ...baseInput,
      pre: { existed: true, contentHash: HASH_A },
      post: { existed: true, contentHash: HASH_A },
    });
    expect(result).toBeUndefined();
  });

  test("undefined for create when post hash is missing (capture failure)", () => {
    const result = buildFileOpRecord({
      ...baseInput,
      pre: { existed: false, contentHash: undefined },
      post: { existed: true, contentHash: undefined },
    });
    expect(result).toBeUndefined();
  });

  test("undefined for delete when pre hash is missing (capture failure)", () => {
    const result = buildFileOpRecord({
      ...baseInput,
      pre: { existed: true, contentHash: undefined },
      post: { existed: false, contentHash: undefined },
    });
    expect(result).toBeUndefined();
  });

  describe("backend field threading", () => {
    test("create record includes backend when provided", () => {
      const result = buildFileOpRecord({
        ...baseInput,
        backend: "nexus:local-bridge",
        pre: { existed: false, contentHash: undefined },
        post: { existed: true, contentHash: HASH_A },
      });
      expect(result?.kind).toBe("create");
      expect(result?.backend).toBe("nexus:local-bridge");
    });

    test("edit record includes backend when provided", () => {
      const result = buildFileOpRecord({
        ...baseInput,
        backend: "nexus:local-bridge",
        pre: { existed: true, contentHash: HASH_A },
        post: { existed: true, contentHash: HASH_B },
      });
      expect(result?.kind).toBe("edit");
      expect(result?.backend).toBe("nexus:local-bridge");
    });

    test("delete record includes backend when provided", () => {
      const result = buildFileOpRecord({
        ...baseInput,
        backend: "nexus:local-bridge",
        pre: { existed: true, contentHash: HASH_A },
        post: { existed: false, contentHash: undefined },
      });
      expect(result?.kind).toBe("delete");
      expect(result?.backend).toBe("nexus:local-bridge");
    });

    test("backend is omitted when not provided (backwards compat)", () => {
      const result = buildFileOpRecord({
        ...baseInput,
        pre: { existed: false, contentHash: undefined },
        post: { existed: true, contentHash: HASH_A },
      });
      expect(result?.kind).toBe("create");
      expect("backend" in (result ?? {})).toBe(false);
    });

    test("backend supports local value", () => {
      const result = buildFileOpRecord({
        ...baseInput,
        backend: "local",
        pre: { existed: true, contentHash: HASH_A },
        post: { existed: true, contentHash: HASH_B },
      });
      expect(result?.backend).toBe("local");
    });
  });
});
