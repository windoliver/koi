import { describe, expect, test } from "bun:test";
import { decodeCursor, encodeCursor } from "../cursor.js";

describe("encodeCursor / decodeCursor", () => {
  test("round-trips a valid cursor", () => {
    const cursor = encodeCursor(1700000000000, 42);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ sortKey: 1700000000000, rowid: 42 });
  });

  test("round-trips zero values", () => {
    const cursor = encodeCursor(0, 0);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ sortKey: 0, rowid: 0 });
  });

  test("returns undefined for empty string", () => {
    expect(decodeCursor("")).toBeUndefined();
  });

  test("returns undefined for invalid base64", () => {
    expect(decodeCursor("!!!not-base64!!!")).toBeUndefined();
  });

  test("returns undefined for missing separator", () => {
    const noSep = Buffer.from("12345").toString("base64url");
    expect(decodeCursor(noSep)).toBeUndefined();
  });

  test("returns undefined for non-numeric values", () => {
    const bad = Buffer.from("abc:def").toString("base64url");
    expect(decodeCursor(bad)).toBeUndefined();
  });

  test("returns undefined for Infinity values", () => {
    const inf = Buffer.from("Infinity:1").toString("base64url");
    expect(decodeCursor(inf)).toBeUndefined();
  });

  test("returns undefined for NaN values", () => {
    const nan = Buffer.from("NaN:1").toString("base64url");
    expect(decodeCursor(nan)).toBeUndefined();
  });

  test("produces different cursors for different inputs", () => {
    const a = encodeCursor(100, 1);
    const b = encodeCursor(100, 2);
    const c = encodeCursor(200, 1);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
