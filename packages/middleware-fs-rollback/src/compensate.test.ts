import { describe, expect, test } from "bun:test";
import type { FileOpRecord } from "@koi/core";
import { computeCompensatingOps } from "./compensate.js";

function makeRecord(
  path: string,
  previousContent: string | undefined,
  newContent: string,
): FileOpRecord {
  return {
    callId: `call-${Date.now()}`,
    kind: "write",
    path,
    previousContent,
    newContent,
    turnIndex: 0,
    eventIndex: -1,
    timestamp: Date.now(),
  };
}

describe("computeCompensatingOps", () => {
  test("returns empty array for empty input", () => {
    const result = computeCompensatingOps([]);
    expect(result).toEqual([]);
  });

  test("returns restore op when previousContent exists", () => {
    const records = [makeRecord("/tmp/a.txt", "original", "modified")];
    const ops = computeCompensatingOps(records);

    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      kind: "restore",
      path: "/tmp/a.txt",
      content: "original",
    });
  });

  test("returns delete op when previousContent is undefined", () => {
    const records = [makeRecord("/tmp/new.txt", undefined, "created")];
    const ops = computeCompensatingOps(records);

    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      kind: "delete",
      path: "/tmp/new.txt",
    });
  });

  test("deduplicates by path keeping earliest previousContent", () => {
    // Newest first: the last entry for a path has the earliest previousContent
    const records = [
      makeRecord("/tmp/a.txt", "version-2", "version-3"), // newer
      makeRecord("/tmp/a.txt", "version-1", "version-2"), // older (earliest)
    ];
    const ops = computeCompensatingOps(records);

    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      kind: "restore",
      path: "/tmp/a.txt",
      content: "version-1",
    });
  });

  test("handles multiple distinct files", () => {
    const records = [
      makeRecord("/tmp/b.txt", "old-b", "new-b"),
      makeRecord("/tmp/a.txt", "old-a", "new-a"),
    ];
    const ops = computeCompensatingOps(records);

    expect(ops).toHaveLength(2);

    const paths = ops.map((op) => op.path).sort();
    expect(paths).toEqual(["/tmp/a.txt", "/tmp/b.txt"]);
  });

  test("dedup: file created then edited yields delete", () => {
    // Newest first: edit (had content), then write (no previous content)
    const records = [
      makeRecord("/tmp/x.txt", "after-create", "after-edit"), // newer (edit)
      makeRecord("/tmp/x.txt", undefined, "after-create"), // older (create)
    ];
    const ops = computeCompensatingOps(records);

    expect(ops).toHaveLength(1);
    // The earliest previousContent is undefined → delete
    expect(ops[0]).toEqual({
      kind: "delete",
      path: "/tmp/x.txt",
    });
  });
});
