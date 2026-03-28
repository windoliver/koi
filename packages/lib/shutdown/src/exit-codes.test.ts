import { describe, expect, it } from "bun:test";
import {
  EXIT_CODES,
  EXIT_CONFIG,
  EXIT_ERROR,
  EXIT_NETWORK,
  EXIT_OK,
  EXIT_TIMEOUT,
  EXIT_UNAVAILABLE,
  exitCodeForError,
} from "./exit-codes.js";

describe("exit codes", () => {
  it("EXIT_OK is 0", () => {
    expect(EXIT_OK).toBe(0);
  });

  it("EXIT_ERROR is 1", () => {
    expect(EXIT_ERROR).toBe(1);
  });

  it("EXIT_NETWORK is 3", () => {
    expect(EXIT_NETWORK).toBe(3);
  });

  it("EXIT_TIMEOUT is 4", () => {
    expect(EXIT_TIMEOUT).toBe(4);
  });

  it("EXIT_UNAVAILABLE is 69 (EX_UNAVAILABLE)", () => {
    expect(EXIT_UNAVAILABLE).toBe(69);
  });

  it("EXIT_CONFIG is 78 (EX_CONFIG)", () => {
    expect(EXIT_CONFIG).toBe(78);
  });

  it("all exit codes are unique", () => {
    const codes = [EXIT_OK, EXIT_ERROR, EXIT_NETWORK, EXIT_TIMEOUT, EXIT_UNAVAILABLE, EXIT_CONFIG];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("EXIT_CODES object contains all codes", () => {
    expect(EXIT_CODES.OK).toBe(EXIT_OK);
    expect(EXIT_CODES.ERROR).toBe(EXIT_ERROR);
    expect(EXIT_CODES.NETWORK).toBe(EXIT_NETWORK);
    expect(EXIT_CODES.TIMEOUT).toBe(EXIT_TIMEOUT);
    expect(EXIT_CODES.UNAVAILABLE).toBe(EXIT_UNAVAILABLE);
    expect(EXIT_CODES.CONFIG).toBe(EXIT_CONFIG);
  });
});

describe("exitCodeForError", () => {
  it("maps VALIDATION to EXIT_CONFIG (78)", () => {
    expect(exitCodeForError("VALIDATION")).toBe(EXIT_CONFIG);
  });

  it("maps RATE_LIMIT to EXIT_UNAVAILABLE (69)", () => {
    expect(exitCodeForError("RATE_LIMIT")).toBe(EXIT_UNAVAILABLE);
  });

  it("maps TIMEOUT to EXIT_TIMEOUT (4)", () => {
    expect(exitCodeForError("TIMEOUT")).toBe(EXIT_TIMEOUT);
  });

  it("maps EXTERNAL to EXIT_NETWORK (3)", () => {
    expect(exitCodeForError("EXTERNAL")).toBe(EXIT_NETWORK);
  });

  it("maps NOT_FOUND to EXIT_ERROR (1)", () => {
    expect(exitCodeForError("NOT_FOUND")).toBe(EXIT_ERROR);
  });

  it("maps PERMISSION to EXIT_ERROR (1)", () => {
    expect(exitCodeForError("PERMISSION")).toBe(EXIT_ERROR);
  });

  it("maps INTERNAL to EXIT_ERROR (1)", () => {
    expect(exitCodeForError("INTERNAL")).toBe(EXIT_ERROR);
  });

  it("maps CONFLICT to EXIT_ERROR (1)", () => {
    expect(exitCodeForError("CONFLICT")).toBe(EXIT_ERROR);
  });

  it("maps unknown codes to EXIT_ERROR (1)", () => {
    expect(exitCodeForError("UNKNOWN_CODE")).toBe(EXIT_ERROR);
  });
});
