import { describe, expect, test } from "bun:test";
import {
  decodeDocId,
  docIdToFilename,
  docIdToMetadataFilename,
  docIdToStepChunkFilename,
  encodeDocId,
  filenameToDocId,
  metadataFilenameToDocId,
  stepChunkFilenameToInfo,
} from "./path-encoding.js";

describe("encodeDocId / decodeDocId", () => {
  test("round-trips ASCII", () => {
    expect(decodeDocId(encodeDocId("session-123"))).toBe("session-123");
  });

  test("round-trips Unicode (emoji, CJK)", () => {
    expect(decodeDocId(encodeDocId("session-🐟"))).toBe("session-🐟");
    expect(decodeDocId(encodeDocId("会话-42"))).toBe("会话-42");
  });

  test("encodes dots to prevent hidden files", () => {
    const encoded = encodeDocId(".hidden");
    expect(encoded.startsWith(".")).toBe(false);
    expect(decodeDocId(encoded)).toBe(".hidden");
  });

  test("encodes slashes to prevent path traversal", () => {
    const encoded = encodeDocId("../../../etc/passwd");
    expect(encoded.includes("/")).toBe(false);
    expect(decodeDocId(encoded)).toBe("../../../etc/passwd");
  });

  test("different inputs produce different outputs", () => {
    expect(encodeDocId("a/b")).not.toBe(encodeDocId("a_b"));
    expect(encodeDocId("a:b")).not.toBe(encodeDocId("a_b"));
  });
});

describe("docIdToFilename / filenameToDocId", () => {
  test("produces .atif.json extension", () => {
    expect(docIdToFilename("test")).toBe("test.atif.json");
  });

  test("round-trips through filename", () => {
    const filename = docIdToFilename("session-🐟");
    expect(filenameToDocId(filename)).toBe("session-🐟");
  });

  test("filenameToDocId returns undefined for non-ATIF files", () => {
    expect(filenameToDocId("readme.md")).toBeUndefined();
    expect(filenameToDocId("data.json")).toBeUndefined();
  });

  test("filenameToDocId returns undefined for malformed percent escapes", () => {
    expect(filenameToDocId("bad%ZZ.atif.json")).toBeUndefined();
    expect(filenameToDocId("%E0%A4%A.atif.json")).toBeUndefined();
  });

  test("decodeDocId returns undefined for malformed percent escapes", () => {
    expect(decodeDocId("bad%ZZ")).toBeUndefined();
  });
});

describe("chunked ATIF filenames", () => {
  test("round-trips metadata filenames", () => {
    const filename = docIdToMetadataFilename("../session.1");
    expect(filename).toBe("%2E%2E%2Fsession%2E1.atif.meta.json");
    expect(metadataFilenameToDocId(filename)).toBe("../session.1");
  });

  test("round-trips step chunk filenames", () => {
    const filename = docIdToStepChunkFilename("session-🐟", 42);
    expect(stepChunkFilenameToInfo(filename)).toEqual({
      docId: "session-🐟",
      startIndex: 42,
    });
  });

  test("ignores malformed step chunk filenames", () => {
    expect(stepChunkFilenameToInfo("session.atif.steps.not-a-number.json")).toBeUndefined();
    expect(stepChunkFilenameToInfo("bad%ZZ.atif.steps.000000000001.json")).toBeUndefined();
  });
});
